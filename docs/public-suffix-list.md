# Adding naru.pub to the Public Suffix List

Status: not submitted. As of 2026-10-01 naru.pub is not on the
[Public Suffix List](https://publicsuffix.org/) (PSL).

## Why it matters

Users publish arbitrary HTML and JavaScript on `<login>.naru.pub`, and the
control plane is served from `naru.pub`. Browsers use the PSL to decide where
one *site* ends and another begins. Because naru.pub is not on the list, today:

- every `<login>.naru.pub` belongs to the same site as `naru.pub` and as every
  other user's site;
- a hosted page can set `Domain=naru.pub` cookies that the control plane and all
  other user sites receive (cookie tossing);
- requests from a hosted page to `naru.pub` count as `same-site`, so
  `SameSite=Lax` cookies are sent with them.

The control plane already defends itself without relying on the PSL. Its
session cookie is `__Host-auth_session`, which no subdomain can set or shadow,
and its mutating routes reject requests whose `Sec-Fetch-Site` is not
`same-origin`. Those defenses stay in place either way. The PSL entry would add
protection that the control plane can't provide by itself: it would separate
user sites from each other and from naru.pub inside the browser.

## What a submission involves

Submissions are pull requests to
[publicsuffix/list](https://github.com/publicsuffix/list). Volunteers maintain
the list, and the rules change over time, so re-read the repository's
CONTRIBUTING / wiki and the PR template before submitting. As of this writing
the process is:

1. **The entry.** Add it to the *private domains* section of
   `public_suffix_list.dat` (between `===BEGIN PRIVATE DOMAINS===` and
   `===END PRIVATE DOMAINS===`). Put it in a block headed by the organization
   and a contact, in the position the current sorting rules require:

   ```
   // Naru : https://naru.pub
   // Submitted by Jihyeok Seo <contact address>
   naru.pub
   ```

   The entry is `naru.pub` itself, not `*.naru.pub`. Listing `naru.pub` makes
   `alice.naru.pub` a registrable domain (its own site). The wildcard would
   instead make `alice.naru.pub` a suffix and `x.alice.naru.pub` the site.

2. **DNS proof.** Create a TXT record at `_psl.naru.pub` whose value is the URL
   of the pull request, for example:

   ```
   _psl.naru.pub.  TXT  "https://github.com/publicsuffix/list/pull/NNNN"
   ```

   The record must stay in place for as long as the entry is on the list. The
   maintainers check it periodically, and they may remove the entry if the
   record disappears.

3. **The PR description.** Fill in the template:
   - **Who:** the organization and a contact.
   - **Why:** for example, "independent users publish untrusted content on
     subdomains and must be isolated from each other and from the control
     plane."
   - **DNS:** the `dig +short TXT _psl.naru.pub` output.
   - **Test:** that the repository's syntax and sort checks pass.

4. **Domain requirements.** Expect to show that naru.pub has at least about two
   years of registration left. Renew ahead of time if needed, and keep it
   renewed. The maintainers reject entries whose main purpose is avoiding
   Let's Encrypt rate limits. User isolation is the accepted reason, so put
   that first.

5. **Timeline.** Review takes weeks to months. After a merge, the change
   reaches users only when browsers and libraries ship a new copy of the list.
   For major browsers that takes one or more release cycles. Libraries
   (Python, Go, curl/libpsl, language HTTP clients) and old browsers can lag
   for years. Removing an entry later is just as slow, so treat the change as
   effectively permanent.

## Side effects

### Cookies

- Browsers that have the updated list reject `Domain=naru.pub` from any page,
  including the control plane. That ends cookie tossing between user sites and
  onto naru.pub.
- The control plane has to keep using host-only cookies. It already does (the
  session cookie is host-only and `__Host-`). Nothing in the control plane
  today shares cookies with subdomains.
- A host that is exactly a public suffix (here `naru.pub`) can still set
  host-only cookies under RFC 6265 §5.3 step 5: a `Domain` attribute equal to
  the host is turned into a host-only cookie. Before submitting, confirm in
  Chrome, Firefox and Safari that signing in on a public-suffix apex works. A
  common alternative is to serve user content from a separate registrable
  domain (the github.io / github.com split), which gets the same isolation
  without depending on how browsers treat a public-suffix apex.
- Older browsers, non-browser HTTP clients and stale PSL copies don't get any
  of this. That is why the `__Host-` cookie and the `Sec-Fetch-Site` checks
  have to stay.

### SameSite, Sec-Fetch-Site and storage

- Requests from `alice.naru.pub` to `naru.pub`, or to `bob.naru.pub`, become
  `cross-site`. `SameSite=Lax` and `SameSite=Strict` cookies are then no longer
  sent on cross-subdomain subresource requests or POSTs.
- The control plane's `Sec-Fetch-Site` checks already reject both `same-site`
  and `cross-site`, so nothing changes there.
- Storage partitioning and third-party cookie blocking key on the top-level
  site. An iframe or fetch of `naru.pub` inside a user site would become
  third-party and lose cookies in browsers that block them. The control plane
  does not depend on this: the Data SDK uses bearer tokens with no cookies,
  `/database/authorize` refuses to be framed and opens top-level, and
  `/sdk/*` is a public, cookie-less script.
- `document.domain` relaxation between user sites becomes impossible. It is
  already disabled by default in current Chromium.

### Browser site isolation

- Chromium's site-per-process (and Firefox Fission) put each *site* in its own
  renderer process. Today all of `*.naru.pub` is one site, so a malicious user
  site can share a process with the control plane or another user's site.
  That makes Spectre-class side channels and renderer-exploit pivots within
  the process possible.
- After the change, each `<login>.naru.pub` is isolated from the others and
  from naru.pub. This is the main security benefit that only the PSL entry, or
  a separate user-content domain, can provide.
- Each user site uses a little more memory when several are open at once.

### Let's Encrypt and other rate limits

- Let's Encrypt computes "certificates per registered domain" (currently 50
  per week) using the PSL, including the private section. After the change,
  each `<login>.naru.pub` counts as its own registered domain.
- This matters only if naru.pub ever issues per-user certificates from Let's
  Encrypt. Subdomain TLS today comes from Cloudflare (a wildcard and Cloudflare
  for SaaS for custom domains), so nothing changes in practice right now.
- Don't use rate limits as the reason for the submission (see above).

### Other effects

- **Password managers.** Chrome and Safari match saved credentials by
  registrable domain. Today a user site may be offered naru.pub's saved
  password as a same-site suggestion. After the change it no longer is, which
  is a phishing reduction.
- **Browser UI and history.** Address-bar eliding, history grouping and
  permission prompts treat each user site as a separate site.
- **Analytics and ads tooling.** Anything that assumes it can set a cookie on
  the registrable domain (`naru.pub`) from a subdomain stops working. Nothing
  in the repository does this.
- **Other naru.pub subdomains** (`media.`, `r2.`, `customers.`) also become
  separate sites from the control plane. None of them relies on cookies.

## Decision checklist

- [ ] Confirm sign-in still works on naru.pub, as a public-suffix apex, in
      Chrome, Firefox and Safari. Or decide to move user content to its own
      domain instead.
- [ ] Renew naru.pub for 2+ years.
- [ ] Open the PR and add the `_psl.naru.pub` TXT record with its URL.
- [ ] Keep `__Host-auth_session` and the `Sec-Fetch-Site` checks regardless.
