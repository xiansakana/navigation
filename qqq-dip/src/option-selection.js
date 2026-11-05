export function selectAffordableCall(contracts, { band, expiries, budget, now = Date.now() }) {
  const eligible = contracts.filter((c) => c.strike >= band?.low && c.strike <= band?.high
    && expiries.includes(c.expiry) && (!c.sharesPerContract || c.sharesPerContract === 100));
  const quoted = eligible.filter((c) => Number.isFinite(c.ask) && c.ask > 0
    && Number.isFinite(Date.parse(c.asOf)) && now - Date.parse(c.asOf) <= 86400000
    && Date.parse(c.asOf) <= now + 300000);
  const costCents = (c) => Math.round(c.ask * 10000);
  const affordable = quoted.filter((c) => costCents(c) <= Math.round(budget * 100));
  const mid = (band?.low + band?.high) / 2;
  affordable.sort((a, b) => Math.abs(a.strike - mid) - Math.abs(b.strike - mid) || a.ask - b.ask);
  const contract = affordable[0];
  return contract ? { contract, shares: Math.floor(Math.round(budget * 100) / costCents(contract)),
    oneContractCost: Math.round(contract.ask * 10000) / 100 } : {
    shares: 0, skipped: true,
    reason: quoted.length ? '预算不足一张合规期权，跳过并保留期权预算'
      : '缺少合规合约的有效卖价，暂停期权建议并保留预算',
    minimumCost: quoted.length ? Math.min(...quoted.map(costCents)) / 100 : null
  };
}
