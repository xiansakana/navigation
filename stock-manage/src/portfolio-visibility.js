const CASH_SUMMARY_FIELDS = [
  'cashUsdEq',
  'totalAssets',
  'totalAssetsCny',
  'assetsUsd',
  'assetsCny'
];

export function redactPortfolioCash(portfolio) {
  const redacted = {
    ...portfolio,
    cashVisible: false,
    summary: { ...(portfolio?.summary || {}) }
  };
  delete redacted.cash;
  delete redacted.cashUsd;
  delete redacted.cashCny;
  CASH_SUMMARY_FIELDS.forEach((field) => { delete redacted.summary[field]; });
  return redacted;
}
