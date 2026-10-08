use anyhow::Result;
use aws_sdk_s3::config::Credentials;
use aws_sdk_s3::Client as S3Client;
use bytes::Bytes;
use http_body_util::Full;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
mod pageviews;
use pageviews::{Pageview, Recorder};
use percent_encoding::percent_decode_str;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use uuid::Uuid;

// Hosted pages are revalidated at the origin on every request, so edits appear
// at once and pageviews are still counted, but Cloudflare keeps the last good
// copy and serves it for up to a day while the origin answers with a 5xx.
const SITE_CACHE_CONTROL: &str = "public, max-age=0, stale-if-error=86400";
// Redirects are deterministic for a path, so browsers may keep them for an hour.
const REDIRECT_CACHE_CONTROL: &str = "public, max-age=3600, stale-if-error=86400";

// Configuration struct
struct Config {
    bucket_name: String,
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
    port: u16,
    database_url: String,
    platform_domain: String,
    r2_public_domain: String,
    payment_grace_days: i64,
}

// Shared state for the application
struct AppState {
    s3_client: S3Client,
    bucket_name: String,
    db_pool: PgPool,
    platform_domain: String,
    r2_public_domain: String,
    payment_grace_days: i64,
    pageviews: Recorder,
}

#[derive(Clone, Debug)]
struct SiteOwner {
    user_id: Uuid,
    login_name: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize configuration
    let config = Config {
        bucket_name: std::env::var("R2_BUCKET_NAME").expect("R2_BUCKET_NAME must be set"),
        account_id: std::env::var("R2_ACCOUNT_ID").expect("R2_ACCOUNT_ID must be set"),
        access_key_id: std::env::var("AWS_ACCESS_KEY_ID").expect("AWS_ACCESS_KEY_ID must be set"),
        secret_access_key: std::env::var("AWS_SECRET_ACCESS_KEY")
            .expect("AWS_SECRET_ACCESS_KEY must be set"),
        port: std::env::var("PORT")
            .unwrap_or_else(|_| "5000".to_string())
            .parse()
            .expect("PORT must be a valid number"),
        database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
        platform_domain: std::env::var("PLATFORM_DOMAIN")
            .or_else(|_| std::env::var("NEXT_PUBLIC_DOMAIN"))
            .unwrap_or_else(|_| "naru.pub".to_string())
            .trim_end_matches('.')
            .to_lowercase(),
        r2_public_domain: std::env::var("R2_PUBLIC_DOMAIN")
            .unwrap_or_else(|_| "r2.naru.pub".to_string())
            .trim_end_matches('.')
            .to_lowercase(),
        payment_grace_days: std::env::var("PAYMENT_GRACE_DAYS")
            .unwrap_or_else(|_| "4".to_string())
            .parse()
            .expect("PAYMENT_GRACE_DAYS must be a valid number"),
    };

    // Initialize R2 client
    let r2_endpoint = format!("https://{}.r2.cloudflarestorage.com", config.account_id);
    let aws_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .endpoint_url(r2_endpoint)
        .region(aws_sdk_s3::config::Region::new("auto"))
        .credentials_provider(Credentials::new(
            config.access_key_id,
            config.secret_access_key,
            None,
            None,
            "R2",
        ))
        .load()
        .await;
    let s3_client = S3Client::new(&aws_config);

    // Initialize database connection pool
    // Fail fast while PostgreSQL is unreachable: the 503 lets Cloudflare serve
    // its stale copy instead of holding visitors for the 30-second default.
    let db_pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to database");
    println!("Connected to database");

    // Analytics has one dedicated connection; bursts never occupy the routing pool.
    let analytics_pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect_lazy(&config.database_url)
        .expect("Invalid analytics database URL");
    let pageviews = Recorder::start(analytics_pool);

    // Create shared application state
    let app_state = Arc::new(AppState {
        s3_client,
        bucket_name: config.bucket_name,
        db_pool,
        platform_domain: config.platform_domain,
        r2_public_domain: config.r2_public_domain,
        payment_grace_days: config.payment_grace_days,
        pageviews,
    });

    // Create a TCP listener
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&addr).await?;
    println!("Server running on http://{}", addr);

    // Handle incoming connections
    loop {
        let (stream, socket_addr) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let state = app_state.clone();
        let client_ip = socket_addr.ip();

        // Spawn a new task for each connection
        tokio::task::spawn(async move {
            if let Err(err) = http1::Builder::new()
                .serve_connection(
                    io,
                    service_fn(move |req| handle_request(req, state.clone(), client_ip)),
                )
                .await
            {
                eprintln!("Error serving connection: {}", err);
            }
        });
    }
}

// Extract client IP from Cloudflare header, X-Forwarded-For, or socket address
fn get_client_ip(req: &Request<hyper::body::Incoming>, socket_ip: IpAddr) -> IpAddr {
    // Cloudflare sets CF-Connecting-IP to the real client IP
    req.headers()
        .get("cf-connecting-ip")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.trim().parse().ok())
        // Fallback to X-Forwarded-For
        .or_else(|| {
            req.headers()
                .get("x-forwarded-for")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.split(',').next())
                .and_then(|s| s.trim().parse().ok())
        })
        .unwrap_or(socket_ip)
}

fn normalize_host(host: &str) -> String {
    host.split(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_lowercase()
}

async fn resolve_site_owner(
    db_pool: &PgPool,
    host: &str,
    platform_domain: &str,
    payment_grace_days: i64,
) -> Result<Option<SiteOwner>, sqlx::Error> {
    let host = normalize_host(host);
    if host.is_empty() || host == platform_domain {
        return Ok(None);
    }

    if let Some(login_name) = host.strip_suffix(&format!(".{}", platform_domain)) {
        if login_name.is_empty() || login_name.contains('.') {
            return Ok(None);
        }

        let user: Option<(Uuid, String)> =
            sqlx::query_as("SELECT id, login_name FROM users WHERE login_name = $1")
                .bind(login_name)
                .fetch_optional(db_pool)
                .await?;

        return Ok(user.map(|(user_id, login_name)| SiteOwner {
            user_id,
            login_name,
        }));
    }

    let domain: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT users.id, users.login_name
     FROM custom_domains
     INNER JOIN users ON users.id = custom_domains.user_id
     WHERE custom_domains.hostname = $1
       AND custom_domains.verified_at IS NOT NULL
       AND custom_domains.cloudflare_status = 'active'
       AND custom_domains.ssl_status = 'active'
       AND (
         users.supporter_comp = TRUE
         OR users.supporter_until > now()
         OR users.supporter_until + ($2::int * INTERVAL '1 day') > now()
       )",
    )
    .bind(&host)
    .bind(payment_grace_days as i32)
    .fetch_optional(db_pool)
    .await?;

    Ok(domain.map(|(user_id, login_name)| SiteOwner {
        user_id,
        login_name,
    }))
}

fn not_found() -> Response<Full<Bytes>> {
    Response::builder()
        .status(404)
        .header("Cache-Control", "no-store")
        .body(Full::new(Bytes::from("Not Found")))
        .unwrap()
}

// A 5xx, never a 404, for failures on our side: Cloudflare replaces a cached
// page with a 404 but falls back to it on a 5xx.
fn unavailable(status: u16) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("Retry-After", "30")
        .body(Full::new(Bytes::from("Service Unavailable")))
        .unwrap()
}

/// Resolve a raw URL path to a file path, appending index.html for directories
fn resolve_path(raw_path: &str) -> String {
    // Check if the last path segment has an extension (e.g., "file.html" but not ".hidden" or "about")
    let last_segment = raw_path.rsplit('/').next().unwrap_or(raw_path);
    let has_extension = last_segment.contains('.')
        && !last_segment.starts_with('.')
        && !last_segment.ends_with('.');

    if raw_path.is_empty() || raw_path == "index.html" {
        "index.html".to_string()
    } else if raw_path.ends_with('/') {
        format!("{}index.html", raw_path)
    } else if !has_extension {
        // Paths like /about should serve /about/index.html
        format!("{}/index.html", raw_path)
    } else {
        raw_path.to_string()
    }
}

// Use the original URL, not the decoded storage key, so reserved characters and
// query parameters retain their meaning. Keep Location on the current origin.
fn directory_redirect(uri: &hyper::Uri, decoded_path: &str) -> Option<String> {
    if uri.path().ends_with('/') || resolve_path(decoded_path) == decoded_path {
        return None;
    }
    let path = uri.path().trim_start_matches('/').replace('\\', "%5C");
    let mut location = format!("/{}/", path);
    if let Some(query) = uri.query() {
        location.push('?');
        location.push_str(query);
    }
    Some(location)
}

// Handle individual HTTP requests
async fn handle_request(
    req: Request<hyper::body::Incoming>,
    state: Arc<AppState>,
    socket_ip: IpAddr,
) -> Result<Response<Full<Bytes>>> {
    let request_kind = pageviews::classify(req.method(), req.headers());
    let request_time = chrono::Utc::now();
    // Get client IP from headers or socket
    let client_ip = get_client_ip(&req, socket_ip);

    // Extract the host from the request headers, with better error handling
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let site_owner = match resolve_site_owner(
        &state.db_pool,
        &host,
        &state.platform_domain,
        state.payment_grace_days,
    )
    .await
    {
        Ok(Some(site_owner)) => site_owner,
        Ok(None) => return Ok(not_found()),
        Err(err) => {
            eprintln!("Error resolving site owner for {}: {}", host, err);
            return Ok(unavailable(503));
        }
    };

    // Extract the Referer header
    let referrer = req
        .headers()
        .get("referer")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    // Extract the User-Agent header
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    let raw_path = req.uri().path().trim_start_matches('/');
    // URL decode the path
    let raw_path = percent_decode_str(raw_path)
        .decode_utf8()
        .unwrap_or_default()
        .to_string();

    // Resolve the path to a file path
    let path = resolve_path(&raw_path);

    // Store the normalized path for pageview tracking (without index.html suffix)
    let pageview_path = if raw_path.is_empty() {
        "/".to_string()
    } else {
        format!(
            "/{}",
            raw_path
                .trim_end_matches("index.html")
                .trim_end_matches('/')
        )
    };
    let pageview_path = if pageview_path.is_empty() {
        "/".to_string()
    } else {
        pageview_path
    };

    let key = format!("{}/{}", site_owner.login_name, path);

    // Determine the file extension
    let extension = path.split('.').last().unwrap_or_default();

    // Check if the extension is html, htm, or js, or json
    if extension != "html" && extension != "htm" && extension != "js" && extension != "json" {
        // Redirect to the specified URL
        let redirect_url = format!(
            "https://{}/{}/{}",
            state.r2_public_domain, site_owner.login_name, path
        );
        return Ok(Response::builder()
            .status(302) // HTTP status code for redirection
            .header("Location", redirect_url)
            .header("Cache-Control", REDIRECT_CACHE_CONTROL)
            .body(Full::new(Bytes::from("Redirecting...")))
            .unwrap());
    }

    // Get the object from S3
    match state
        .s3_client
        .get_object()
        .bucket(&state.bucket_name)
        .key(&key)
        .send()
        .await
    {
        Ok(resp) => {
            // Only canonicalize existing directories. Do not count the redirect
            // as a pageview; the subsequent request records the HTML page once.
            if let Some(location) = directory_redirect(req.uri(), &raw_path) {
                return Ok(Response::builder()
                    .status(308)
                    .header("Location", location)
                    .header("Cache-Control", REDIRECT_CACHE_CONTROL)
                    .body(Full::new(Bytes::new()))?);
            }
            let content_type = resp.content_type.clone().unwrap_or_default();
            let data = match resp.body.collect().await {
                Ok(body) => body.into_bytes(),
                Err(err) => {
                    eprintln!("Error reading {} from S3: {}", key, err);
                    return Ok(unavailable(502));
                }
            };

            // Classify successful HTML requests; only top-level GET navigations enqueue.
            if extension == "html" || extension == "htm" {
                state.pageviews.record(
                    request_kind,
                    Pageview {
                        user_id: site_owner.user_id,
                        path: pageview_path,
                        ip: client_ip.into(),
                        referrer,
                        user_agent,
                        timestamp: request_time,
                    },
                );
            }

            Ok(Response::builder()
                .status(200)
                .header("content-type", content_type)
                .header("Cache-Control", SITE_CACHE_CONTROL)
                .body(Full::new(data))
                .unwrap())
        }
        Err(err) if err.as_service_error().is_some_and(|e| e.is_no_such_key()) => Ok(not_found()),
        Err(err) => {
            eprintln!("Error fetching {} from S3: {}", key, err);
            Ok(unavailable(502))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_redirect_preserves_url_and_query() {
        for (url, decoded, expected) in [
            ("/blog", "blog", "/blog/"),
            (
                "/nested/blog?page=2&tag=a%2Fb",
                "nested/blog",
                "/nested/blog/?page=2&tag=a%2Fb",
            ),
            (
                "/%EB%B8%94%EB%A1%9C%EA%B7%B8",
                "블로그",
                "/%EB%B8%94%EB%A1%9C%EA%B7%B8/",
            ),
            ("/a%3Fb%23c", "a?b#c", "/a%3Fb%23c/"),
            ("/blog%2F", "blog/", "/blog%2F/"),
            (
                "//example.com/blog",
                "example.com/blog",
                "/example.com/blog/",
            ),
            ("/blog?", "blog", "/blog/?"),
        ] {
            assert_eq!(
                directory_redirect(&url.parse().unwrap(), decoded).as_deref(),
                Some(expected),
            );
        }
    }

    #[test]
    fn directory_redirect_leaves_files_and_canonical_urls_alone() {
        for (url, decoded) in [
            ("/", ""),
            ("/blog/", "blog/"),
            ("/blog/?page=2", "blog/"),
            ("/index.html", "index.html"),
            ("/blog/index.html", "blog/index.html"),
            ("/blog/app.js", "blog/app.js"),
        ] {
            assert_eq!(directory_redirect(&url.parse().unwrap(), decoded), None);
        }
    }

    #[test]
    fn test_resolve_path_root() {
        assert_eq!(resolve_path(""), "index.html");
    }

    #[test]
    fn test_resolve_path_index_html() {
        assert_eq!(resolve_path("index.html"), "index.html");
    }

    #[test]
    fn test_resolve_path_trailing_slash() {
        assert_eq!(resolve_path("about/"), "about/index.html");
        assert_eq!(resolve_path("foo/bar/"), "foo/bar/index.html");
    }

    #[test]
    fn test_resolve_path_directory_without_slash() {
        assert_eq!(resolve_path("about"), "about/index.html");
        assert_eq!(resolve_path("foo/bar"), "foo/bar/index.html");
    }

    #[test]
    fn test_resolve_path_with_extension() {
        assert_eq!(resolve_path("file.html"), "file.html");
        assert_eq!(resolve_path("script.js"), "script.js");
        assert_eq!(resolve_path("data.json"), "data.json");
        assert_eq!(resolve_path("path/to/file.html"), "path/to/file.html");
    }

    #[test]
    fn test_resolve_path_dot_in_directory() {
        // Dot in directory name, but last segment has no extension
        assert_eq!(resolve_path("my.site/about"), "my.site/about/index.html");
        assert_eq!(resolve_path("v1.0/docs"), "v1.0/docs/index.html");
    }

    #[test]
    fn test_resolve_path_hidden_files() {
        // Hidden files (starting with dot) should be treated as no extension
        assert_eq!(resolve_path(".hidden"), ".hidden/index.html");
        assert_eq!(resolve_path("path/.env"), "path/.env/index.html");
    }

    #[test]
    fn test_resolve_path_trailing_dot() {
        // Trailing dot should be treated as no extension
        assert_eq!(resolve_path("file."), "file./index.html");
    }
}
