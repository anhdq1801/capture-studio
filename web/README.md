# Capture Studio — website

Static site: landing page, pricing, and the three documents a payment provider will ask to see
before they let you take money.

Nothing here is generated or built. It is five HTML files, one stylesheet and one script, so it
can be dropped on any static host.

## Building

Nothing here is compiled, but the placeholders below have to be filled in before any of it can
go public, and nothing was checking that they were. Shipping `[[SUPPORT_EMAIL]]` on a legal page
or an empty `[[API_BASE_URL]]` — which leaves pricing and password reset silently dead — was
always one careless deploy away.

Put the real values in `site.config.json`, then:

```
npm run build:web      # from the repo root
```

That writes `web/dist/`. It refuses to write anything at all if a placeholder has no value, if
a value is not the shape it should be, or if any `[[...]]` survives substitution — so a broken
site fails at your terminal rather than in front of a customer.

It also cross-checks `GRACE_DAYS` against `LAPSE_GRACE_DAYS` in `../server/src/cleanup.ts`.
That number is a promise the nightly job enforces, written down in two languages in two places;
this is the one that stops them drifting apart.

The four `SHOT_` screenshots are the exception: leave them empty and the build warns, fills the
frames with a transparent pixel and carries on. A site with no support address is broken; a
site with no screenshots is merely unfinished.

## Deploying to Cloudflare Pages

Same account as the Worker, so the site and the API can share a domain and there is no second
vendor to manage.

```
npm run build:web
npx wrangler pages deploy web/dist --project-name capture-studio-site
```

Deploy `web/dist`, never `web` — the source still has the placeholders in it.

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

Every value that is not yet decided is written as `[[NAME]]`. They live in
`site.config.json`, one key per row of this table, and `npm run build:web` is what puts them
into the pages. To see which are still outstanding, just run it — it lists them.

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
| `[[SHOT_EDITOR]]` | wide shot of the annotation editor on a real capture |
| `[[SHOT_OVERLAY]]` | the selection crosshair mid-drag, with the size readout visible |
| `[[SHOT_OCR]]` | text recognition running on a region |
| `[[SHOT_LIBRARY]]` | the library grid, with both screenshots and a recording in it |

The four `SHOT_` placeholders are the only ones that are not a line of text — they are image
files. Put them in `web/assets/` and point the `src` at them. Until then the page renders empty
framed boxes at the right size, so the layout is already correct and nothing shifts when the
real pictures land.

Take them at 2× and export around 2400px wide; the frames are `16/10` for the large shot and
`4/3` for the row of three, and anything else gets cropped to fit. A screenshot tool whose site
has no screenshots is the one thing a visitor will notice, so these matter more than any of the
copy around them.

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
