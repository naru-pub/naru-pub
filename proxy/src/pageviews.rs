//! Best-effort analytics: navigation intent, bounded memory, atomic persistence.
use chrono::{DateTime, Utc};
use hyper::{HeaderMap, Method};
use ipnetwork::IpNetwork;
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::mpsc;
use uuid::Uuid;

const QUEUE_CAPACITY: usize = 256;
const MAX_METADATA_BYTES: usize = 2048;

#[derive(Debug, PartialEq)]
pub enum RequestKind {
    Navigation,
    Frame,
    Background,
    Unknown,
}

pub fn classify(method: &Method, headers: &HeaderMap) -> RequestKind {
    if method != Method::GET {
        return RequestKind::Background;
    }
    let mode = headers.get("sec-fetch-mode").and_then(|v| v.to_str().ok());
    let dest = headers.get("sec-fetch-dest").and_then(|v| v.to_str().ok());
    match (mode, dest) {
        (Some("navigate"), Some("document")) => RequestKind::Navigation,
        (Some("navigate"), Some("iframe" | "frame")) => RequestKind::Frame,
        (None, _) | (_, None) => RequestKind::Unknown,
        _ => RequestKind::Background,
    }
}

pub struct Pageview {
    pub user_id: Uuid,
    pub path: String,
    pub ip: IpNetwork,
    pub referrer: Option<String>,
    pub user_agent: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Default)]
struct Counters {
    recorded: AtomicU64,
    dropped: AtomicU64,
    failed: AtomicU64,
    frame: AtomicU64,
    background: AtomicU64,
    unknown: AtomicU64,
}

#[derive(Clone)]
pub struct Recorder {
    sender: mpsc::Sender<Pageview>,
    counters: Arc<Counters>,
}

fn truncate(value: &mut String) {
    let mut end = value.len().min(MAX_METADATA_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

impl Recorder {
    pub fn start(pool: PgPool) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Pageview>(QUEUE_CAPACITY);
        let counters = Arc::new(Counters::default());
        let worker_counters = counters.clone();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                match persist(&pool, &event).await {
                    Ok(()) => {
                        worker_counters.recorded.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(error) => {
                        worker_counters.failed.fetch_add(1, Ordering::Relaxed);
                        eprintln!("pageview persistence failed: {error}");
                    }
                }
            }
        });
        let metrics = counters.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            tick.tick().await;
            loop {
                tick.tick().await;
                eprintln!("pageviews interval=60s recorded={} dropped={} failed={} frame={} background={} unknown={}",
                    metrics.recorded.swap(0, Ordering::Relaxed), metrics.dropped.swap(0, Ordering::Relaxed),
                    metrics.failed.swap(0, Ordering::Relaxed), metrics.frame.swap(0, Ordering::Relaxed),
                    metrics.background.swap(0, Ordering::Relaxed), metrics.unknown.swap(0, Ordering::Relaxed));
            }
        });
        Self { sender, counters }
    }

    pub fn record(&self, kind: RequestKind, mut event: Pageview) {
        let excluded = match kind {
            RequestKind::Navigation => None,
            RequestKind::Frame => Some(&self.counters.frame),
            RequestKind::Background => Some(&self.counters.background),
            RequestKind::Unknown => Some(&self.counters.unknown),
        };
        if let Some(counter) = excluded {
            counter.fetch_add(1, Ordering::Relaxed);
            return;
        }
        truncate(&mut event.path);
        if let Some(value) = &mut event.referrer {
            truncate(value);
        }
        if let Some(value) = &mut event.user_agent {
            truncate(value);
        }
        if self.sender.try_send(event).is_err() {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// The unique constraint serializes concurrent first visits; all three writes
// commit together. Day follows the request timestamp in UTC, even across queue delay.
async fn persist(pool: &PgPool, event: &Pageview) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    let first_visit = sqlx::query(
        "INSERT INTO pageview_daily_visitors (user_id, date, ip) VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date, $3) ON CONFLICT (user_id, date, ip) DO NOTHING"
    ).bind(event.user_id).bind(event.timestamp).bind(event.ip).execute(&mut *tx).await?.rows_affected();
    sqlx::query("INSERT INTO pageviews (user_id, timestamp, path, ip, referrer, user_agent) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(event.user_id).bind(event.timestamp).bind(&event.path).bind(event.ip)
        .bind(&event.referrer).bind(&event.user_agent).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO pageview_daily_stats (user_id, date, views, unique_visitors) VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date, 1, $3) ON CONFLICT (user_id, date) DO UPDATE SET views = pageview_daily_stats.views + 1, unique_visitors = pageview_daily_stats.unique_visitors + EXCLUDED.unique_visitors")
        .bind(event.user_id).bind(event.timestamp).bind(first_visit as i32).execute(&mut *tx).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_navigation_without_relying_on_site_or_referrer() {
        for (method, mode, dest, expected) in [
            (
                Method::GET,
                Some("navigate"),
                Some("document"),
                RequestKind::Navigation,
            ),
            (
                Method::GET,
                Some("navigate"),
                Some("iframe"),
                RequestKind::Frame,
            ),
            (
                Method::GET,
                Some("cors"),
                Some("empty"),
                RequestKind::Background,
            ),
            (
                Method::GET,
                Some("same-origin"),
                Some("empty"),
                RequestKind::Background,
            ),
            (
                Method::HEAD,
                Some("navigate"),
                Some("document"),
                RequestKind::Background,
            ),
            (
                Method::POST,
                Some("navigate"),
                Some("document"),
                RequestKind::Background,
            ),
            (Method::GET, None, None, RequestKind::Unknown),
            (Method::GET, Some("navigate"), None, RequestKind::Unknown),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(value) = mode {
                headers.insert("sec-fetch-mode", value.parse().unwrap());
            }
            if let Some(value) = dest {
                headers.insert("sec-fetch-dest", value.parse().unwrap());
            }
            assert_eq!(classify(&method, &headers), expected);
        }
    }

    // Explicitly opt into a migrated disposable database, never DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires NARU_PAGEVIEW_TEST_DATABASE_URL pointing to a disposable migrated database"]
    async fn database_concurrency_utc_and_rollback() {
        let url = std::env::var("NARU_PAGEVIEW_TEST_DATABASE_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(8)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET TIME ZONE 'Asia/Seoul'")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (login_name, password_hash) VALUES ('pageview-proxy-test', 'x') RETURNING id")
            .fetch_one(&pool).await.unwrap();
        let event = Arc::new(Pageview {
            user_id,
            path: "/".into(),
            ip: "192.0.2.1".parse().unwrap(),
            referrer: None,
            user_agent: None,
            timestamp: "2026-10-07T23:59:59Z".parse().unwrap(),
        });
        let mut tasks = Vec::new();
        for _ in 0..32 {
            let pool = pool.clone();
            let event = event.clone();
            tasks.push(tokio::spawn(async move {
                persist(&pool, &event).await.unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        let stats: (i32, i32, String) = sqlx::query_as(
            "SELECT views, unique_visitors, date::text FROM pageview_daily_stats WHERE user_id=$1",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stats, (32, 1, "2026-10-07".into()));
        sqlx::query("UPDATE pageview_daily_stats SET views=2147483647 WHERE user_id=$1")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap();
        let failed = Pageview {
            user_id,
            path: "/rollback".into(),
            ip: "192.0.2.2".parse().unwrap(),
            referrer: None,
            user_agent: None,
            timestamp: event.timestamp,
        };
        assert!(persist(&pool, &failed).await.is_err());
        let events: i64 = sqlx::query_scalar("SELECT count(*) FROM pageviews WHERE user_id=$1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let visitors: i64 =
            sqlx::query_scalar("SELECT count(*) FROM pageview_daily_visitors WHERE user_id=$1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((events, visitors), (32, 1));
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn queue_sheds_load_and_bounds_utf8_metadata() {
        let (sender, mut receiver) = mpsc::channel(1);
        let recorder = Recorder {
            sender,
            counters: Arc::new(Counters::default()),
        };
        let event = || Pageview {
            user_id: Uuid::nil(),
            path: "한".repeat(2000),
            ip: "127.0.0.1".parse().unwrap(),
            referrer: None,
            user_agent: None,
            timestamp: Utc::now(),
        };
        recorder.record(RequestKind::Background, event());
        assert!(receiver.try_recv().is_err());
        recorder.record(RequestKind::Navigation, event());
        recorder.record(RequestKind::Navigation, event());
        assert_eq!(recorder.counters.dropped.load(Ordering::Relaxed), 1);
        assert!(receiver.recv().await.unwrap().path.len() <= MAX_METADATA_BYTES);
    }
}
