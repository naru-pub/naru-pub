use anyhow::Result;
use aws_sdk_s3::config::Credentials;
use aws_sdk_s3::Client as S3Client;
use bytes::Bytes;
use http_body_util::Full;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use ipnetwork::IpNetwork;
use percent_encoding::percent_decode_str;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

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
    feature_access_mode: String,
}

// Shared state for the application
struct AppState {
    s3_client: S3Client,
    bucket_name: String,
    db_pool: PgPool,
    platform_domain: String,
    r2_public_domain: String,
    payment_grace_days: i64,
    feature_access_mode: String,
}

#[derive(Clone, Debug)]
struct SiteOwner {
    user_id: i32,
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
        feature_access_mode: std::env::var("FEATURE_ACCESS_MODE")
            .unwrap_or_else(|_| "preview".to_string()),
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
    let db_pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to database");
    println!("Connected to database");

    // Create shared application state
    let app_state = Arc::new(AppState {
        s3_client,
        bucket_name: config.bucket_name,
        db_pool,
        platform_domain: config.platform_domain,
        r2_public_domain: config.r2_public_domain,
        payment_grace_days: config.payment_grace_days,
        feature_access_mode: config.feature_access_mode,
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
    feature_access_mode: &str,
) -> Option<SiteOwner> {
    let host = normalize_host(host);
    if host.is_empty() || host == platform_domain {
        return None;
    }

    if let Some(login_name) = host.strip_suffix(&format!(".{}", platform_domain)) {
        if login_name.is_empty() || login_name.contains('.') {
            return None;
        }

        let user_result: Result<Option<(i32, String)>, _> =
            sqlx::query_as("SELECT id, login_name FROM users WHERE login_name = $1")
                .bind(login_name)
                .fetch_optional(db_pool)
                .await;

        return match user_result {
            Ok(Some((user_id, login_name))) => Some(SiteOwner {
                user_id,
                login_name,
            }),
            Ok(None) => None,
            Err(err) => {
                eprintln!("Error resolving platform subdomain: {}", err);
                None
            }
        };
    }

    let domain_result: Result<Option<(i32, String)>, _> = if feature_access_mode == "supporters" {
        sqlx::query_as(
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
        .await
    } else {
        sqlx::query_as(
            "SELECT users.id, users.login_name
         FROM custom_domains
         INNER JOIN users ON users.id = custom_domains.user_id
         WHERE custom_domains.hostname = $1
           AND custom_domains.verified_at IS NOT NULL
           AND custom_domains.cloudflare_status = 'active'
           AND custom_domains.ssl_status = 'active'
           AND users.supporter_comp = TRUE",
        )
        .bind(&host)
        .fetch_optional(db_pool)
        .await
    };

    match domain_result {
        Ok(Some((user_id, login_name))) => Some(SiteOwner {
            user_id,
            login_name,
        }),
        Ok(None) => None,
        Err(err) => {
            eprintln!("Error resolving custom domain: {}", err);
            None
        }
    }
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

// Record a pageview in the database (fire-and-forget)
fn record_pageview(
    db_pool: PgPool,
    user_id: i32,
    path: String,
    client_ip: IpAddr,
    referrer: Option<String>,
    user_agent: Option<String>,
) {
    tokio::spawn(async move {
        // Convert IpAddr to IpNetwork for PostgreSQL inet type
        let ip_network = IpNetwork::from(client_ip);

        // Check if this IP has already been seen today for this user
        let is_new_visitor: bool = sqlx::query_scalar(
            "SELECT NOT EXISTS (
                SELECT 1 FROM pageviews
                WHERE user_id = $1
                AND ip = $2
                AND timestamp >= CURRENT_DATE
            )",
        )
        .bind(user_id)
        .bind(ip_network)
        .fetch_one(&db_pool)
        .await
        .unwrap_or(false);

        // Insert pageview record
        let insert_result = sqlx::query(
            "INSERT INTO pageviews (user_id, path, ip, referrer, user_agent) VALUES ($1, $2, $3, $4, $5)"
        )
        .bind(user_id)
        .bind(&path)
        .bind(ip_network)
        .bind(&referrer)
        .bind(&user_agent)
        .execute(&db_pool)
        .await;

        if let Err(e) = insert_result {
            eprintln!("Error recording pageview: {}", e);
            return;
        }

        // Update daily stats (upsert)
        let unique_increment = if is_new_visitor { 1 } else { 0 };
        let stats_result = sqlx::query(
            "INSERT INTO pageview_daily_stats (user_id, date, views, unique_visitors)
            VALUES ($1, CURRENT_DATE, 1, $2)
            ON CONFLICT (user_id, date) DO UPDATE SET
                views = pageview_daily_stats.views + 1,
                unique_visitors = pageview_daily_stats.unique_visitors + $2",
        )
        .bind(user_id)
        .bind(unique_increment)
        .execute(&db_pool)
        .await;

        if let Err(e) = stats_result {
            eprintln!("Error updating daily stats: {}", e);
        }
    });
}

// Handle individual HTTP requests
async fn handle_request(
    req: Request<hyper::body::Incoming>,
    state: Arc<AppState>,
    socket_ip: IpAddr,
) -> Result<Response<Full<Bytes>>> {
    // Get client IP from headers or socket
    let client_ip = get_client_ip(&req, socket_ip);

    // Extract the host from the request headers, with better error handling
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let site_owner = resolve_site_owner(
        &state.db_pool,
        &host,
        &state.platform_domain,
        state.payment_grace_days,
        &state.feature_access_mode,
    )
    .await;

    let Some(site_owner) = site_owner else {
        return Ok(Response::builder()
            .status(404)
            .body(Full::new(Bytes::from("Not Found")))
            .unwrap());
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
            .header("Cache-Control", "public, max-age=3600")
            .body(Full::new(Bytes::from("Redirecting...")))
            .unwrap());
    }

    // Get the object from S3
    match state
        .s3_client
        .get_object()
        .bucket(&state.bucket_name)
        .key(key)
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
                    .header("Cache-Control", "public, max-age=3600")
                    .body(Full::new(Bytes::new()))?);
            }
            let content_type = resp.content_type.clone().unwrap_or_default();
            let data = resp.body.collect().await?.into_bytes();

            // Record pageview for HTML pages only (fire-and-forget)
            if extension == "html" || extension == "htm" {
                record_pageview(
                    state.db_pool.clone(),
                    site_owner.user_id,
                    pageview_path,
                    client_ip,
                    referrer,
                    user_agent,
                );
            }

            Ok(Response::builder()
                .status(200)
                .header("content-type", content_type)
                .header("Cache-Control", "public, max-age=3600")
                .body(Full::new(data))
                .unwrap())
        }
        Err(err) => {
            eprintln!("Error fetching from S3: {}", err);
            Ok(Response::builder()
                .status(404)
                .body(Full::new(Bytes::from("Not Found")))
                .unwrap())
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
