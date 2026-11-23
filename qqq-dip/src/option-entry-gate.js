export function optionEntryBlock(tier, qqq) {
  if (!/^T[1-7]$/.test(tier?.id) || !Number.isFinite(tier.triggerPrice)) return null;
  if (!Number.isFinite(qqq?.price) || qqq.price <= 0) return '缺少有效 QQQ 现价，暂停本档期权买入';
  if (qqq.price > tier.triggerPrice) {
    return `QQQ 现价 ${qqq.price.toFixed(3)} 已高于 ${tier.id} 触发价 ${tier.triggerPrice.toFixed(3)}，保留期权预算`;
  }
  return null;
}
