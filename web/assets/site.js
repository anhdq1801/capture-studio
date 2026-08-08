/* Capture Studio — site behaviour.
 *
 * Two jobs: render the plan ladder from the API, and show the hero's dimension readout as a
 * real measurement of the element it labels. Nothing else runs. */

/** Worker origin. Must be set before the pricing table can render. */
const API_BASE = window.CAPTURE_STUDIO_API || "";

/* ---- Hero readout ----
 * The badge reports the actual pixel size of the selection it sits on, so it changes with the
 * viewport exactly as it would while dragging. A hardcoded "1440 × 900" would be a picture of
 * a measurement rather than one. */
function trackReadout() {
  const box = document.querySelector("[data-selection]");
  const out = document.querySelector("[data-readout]");
  if (!box || !out) return;

  const update = () => {
    const r = box.getBoundingClientRect();
    out.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  };
  update();
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(box);
  else window.addEventListener("resize", update);
}

/* ---- Pricing ---- */

const fmtUsd = (cents) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Bytes as the round number the tier was sold as, not a computed approximation. */
function sizeParts(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return [String(Math.round(gb)), "GB"];
  return [String(Math.round(bytes / 1024 ** 2)), "MB"];
}

function tierCard(tier, interval, base, recommended) {
  const price = interval === "annual" ? tier.annual : tier.monthly;
  const [size, unit] = sizeParts(tier.bytes);
  const li = document.createElement("li");
  li.className = recommended ? "tier pick" : "tier";

  // Says what the step up actually buys, in the numbers on the card, rather than asserting
  // that this is the popular one. The flag element is always present so the storage figures
  // stay on one line across all four cards.
  let flagText = "";
  if (recommended && base) {
    const times = Math.round(tier.bytes / base.bytes);
    const basePrice = interval === "annual" ? base.annual : base.monthly;
    const extra = price.usdCents - basePrice.usdCents;
    flagText = `${times}× storage, +${fmtUsd(extra)}`;
  }
  const flag = `<p class="tier-flag">${flagText || "&nbsp;"}</p>`;

  // Annual is charged once for the year; showing the monthly equivalent underneath is the
  // honest way to let someone compare it against the monthly price above.
  const per =
    interval === "annual"
      ? `<p class="tier-per">Billed once a year · ${fmtUsd(
          Math.round(price.usdCents / 12)
        )} a month</p>`
      : `<p class="tier-per">Billed monthly</p>`;

  li.innerHTML = `
    ${flag}
    <p class="tier-size">${size}<span class="unit">${unit}</span></p>
    <p class="tier-price">${fmtUsd(price.usdCents)}</p>
    ${per}
  `;
  return li;
}

function renderTiers(pricing, interval) {
  const list = document.querySelector("[data-tiers]");
  if (!list) return;
  list.textContent = "";
  // Second-cheapest is the one worth pointing at: the entry tier exists to have a floor,
  // and the step up from it is where the storage actually becomes useful.
  const pick = pricing.tiers.length > 1 ? pricing.tiers[1].id : null;
  const base = pricing.tiers[0];
  for (const tier of pricing.tiers) {
    list.appendChild(tierCard(tier, interval, base, tier.id === pick));
  }
}

async function loadPricing() {
  const list = document.querySelector("[data-tiers]");
  const fallback = document.querySelector("[data-pricing-fallback]");
  if (!list) return;

  if (!API_BASE) {
    if (fallback) fallback.hidden = false;
    return;
  }

  try {
    const res = await fetch(`${API_BASE.replace(/\/$/, "")}/pricing`);
    if (!res.ok) throw new Error(String(res.status));
    const pricing = await res.json();

    let interval = "annual";
    renderTiers(pricing, interval);

    document.querySelectorAll("[data-interval]").forEach((btn) => {
      btn.addEventListener("click", () => {
        interval = btn.dataset.interval;
        document.querySelectorAll("[data-interval]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        renderTiers(pricing, interval);
      });
    });

    document.querySelectorAll("[data-grace-days]").forEach((el) => {
      el.textContent = String(pricing.lapseGraceDays);
    });
  } catch {
    // Prices are never guessed at locally. Saying so is better than showing a stale number
    // that the checkout would then contradict.
    if (fallback) fallback.hidden = false;
  }
}

trackReadout();
loadPricing();
