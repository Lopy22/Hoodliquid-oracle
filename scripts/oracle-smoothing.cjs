const PRICE_SCALE = 1_000_000;

const EWMA_TIERS = [
  { maxDeviationBps: 300, alpha: 1, tier: "direct" },
  { maxDeviationBps: 500, alpha: 0.3, tier: "moderate" },
  { maxDeviationBps: 1_500, alpha: 0.1, tier: "heavy" },
  { maxDeviationBps: Infinity, alpha: 0.01, tier: "spike" }
];

function smoothQuote(rawPrice, previousQuote, now, source, options = {}) {
  const { snapshotOnly = false, metadata = {}, priceFloor = 0 } = options;

  if (snapshotOnly) {
    return makeQuote({
      rawPrice,
      price: rawPrice,
      now,
      source,
      metadata,
      priceFloor,
      smoothing: {
        status: "snapshot",
        tier: "snapshot",
        alpha: 0,
        returnBps: 0,
        reason: "snapshot pricing due to TCGPlayer API limitation"
      }
    });
  }

  const previousPrice = Number(previousQuote?.price || 0);
  if (priceFloor > 0 && rawPrice < priceFloor) {
    if (!previousPrice) {
      throw new Error(`raw price ${formatScaled(rawPrice)} is below configured floor ${formatScaled(priceFloor)}`);
    }

    return makeQuote({
      rawPrice,
      price: previousPrice,
      now: Number(previousQuote.lastUpdateTime || 0),
      source,
      metadata,
      priceFloor,
      smoothing: {
        status: "rejected",
        tier: "floor",
        alpha: 0,
        returnBps: Math.round(((rawPrice - previousPrice) * 10_000) / previousPrice),
        reason: `raw price ${formatScaled(rawPrice)} is below configured floor ${formatScaled(priceFloor)}`
      }
    });
  }

  if (!previousPrice) {
    return makeQuote({
      rawPrice,
      price: rawPrice,
      now,
      source,
      metadata,
      priceFloor,
      smoothing: {
        status: "initialized",
        tier: "direct",
        alpha: 1,
        returnBps: 0
      }
    });
  }

  const signedReturnBps = ((rawPrice - previousPrice) * 10_000) / previousPrice;
  const absReturnBps = Math.abs(signedReturnBps);
  const selectedTier = absReturnBps < 300
    ? EWMA_TIERS[0]
    : absReturnBps < 500
      ? EWMA_TIERS[1]
      : absReturnBps <= 1_500
        ? EWMA_TIERS[2]
        : EWMA_TIERS[3];
  const price = Math.round(selectedTier.alpha * rawPrice + (1 - selectedTier.alpha) * previousPrice);

  return makeQuote({
    rawPrice,
    price,
    now,
    source,
    metadata,
    priceFloor,
    smoothing: {
      status: "accepted",
      tier: selectedTier.tier,
      alpha: selectedTier.alpha,
      returnBps: Math.round(signedReturnBps),
      reason: selectedTier.tier === "spike" ? "deviation over 15%; near-total EWMA rejection applied" : undefined
    }
  });
}

function makeQuote({ rawPrice, price, now, source, metadata, priceFloor, smoothing }) {
  return {
    ...definedMetadata(metadata),
    price,
    rawPrice,
    ewma: price / PRICE_SCALE,
    lastUpdateTime: now,
    source,
    priceFloor,
    smoothing: {
      ...smoothing,
      maxMoveBps: 1_500,
      volatilityBps: Math.abs(Number(smoothing.returnBps || 0))
    }
  };
}

function definedMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function formatScaled(value) {
  return `$${(value / PRICE_SCALE).toFixed(2)}`;
}

module.exports = {
  EWMA_TIERS,
  PRICE_SCALE,
  smoothQuote
};
