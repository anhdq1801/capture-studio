# Capture Studio — website

Static site: landing page, pricing, and the three documents a payment provider will ask to see
before they let you take money.

Nothing here is generated or built. It is five HTML files, one stylesheet and one script, so it
can be dropped on any static host.

## Deploying to Cloudflare Pages

Same account as the Worker, so the site and the API can share a domain and there is no second
vendor to manage.

```
npx wrangler pages deploy web --project-name capture-studio-site
```

Then attach the domain in the Cloudflare dashboard. Two subdomains off one root work well:

| Host | Serves |
| --- | --- |
| `capturestudio.app` | this site (Pages) |
| `api.capturestudio.app` | the Worker in `../server` |
| `cdn.capturestudio.app` | the R2 bucket — see `../server/README.md`, it must be a custom domain |

## Prices are not written into these files

`pricing.html` reads `GET /pricing` from the Worker at load. That endpoint is the same one the
desktop app uses, so the site, the app and the checkout can never quote three different
numbers. Set the origin in `pricing.html`:

```html
<script>
  window.CAPTURE_STUDIO_API = "https://api.capturestudio.app";
</script>
```

If the API cannot be reached, the page says so and points at the app instead of showing a
number it cannot stand behind. The `/pricing` route sends `Access-Control-Allow-Origin: *`
specifically so this fetch works from a browser; no other route does.

## Placeholders

Every value that is not yet decided is written as `[[NAME]]`. Find them all with:

```
grep -rn '\[\[' web/
```

| Placeholder | What it is |
| --- | --- |
| `[[LEGAL_ENTITY]]` | the name that appears on the invoice — a registered company or sole trader |
| `[[REGISTERED_ADDRESS]]` | required on the legal pages by most payment providers |
| `[[SUPPORT_EMAIL]]` | must be on your own domain; FastSpring and similar reject Gmail |
| `[[JURISDICTION]]` | the law and courts the terms answer to |
| `[[EFFECTIVE_DATE]]` | the date each document takes effect |
| `[[PAYMENT_PROVIDER]]` | whoever ends up processing payments, named in all three documents |
| `[[GRACE_DAYS]]` | must equal `LAPSE_GRACE_DAYS` in `../server/src/cleanup.ts` — currently **30** |
| `[[REFUND_WINDOW_DAYS]]` | a business decision; 14 is the common choice for software |
| `[[SUPPORT_RESPONSE_DAYS]]` | how fast you promise to answer a refund request |
| `[[API_BASE_URL]]` | origin of the Worker, in `pricing.html` |
| `[[DOWNLOAD_URL]]` | the signed, notarised `.dmg` |

`[[GRACE_DAYS]]` is the one that must not drift: it is a promise to customers that a nightly
job enforces. The pricing page reads the real number from the API into any element marked
`data-grace-days`; the legal pages state it as text, so if `LAPSE_GRACE_DAYS` ever changes,
change it here too.

## The legal pages are drafts

Each one opens with a visible draft notice. They describe how the software actually behaves —
checked against the source, not copied from a generator — but they have not been reviewed by
anyone qualified. Get that done before taking payments, and delete the notice afterwards.

Two things in them are business decisions rather than descriptions, and need your answer before
review: the refund window, and whether you will offer a free storage tier (the documents
currently assume no free cloud tier, matching `NO_PLAN_STORAGE_BYTES = 0`).
