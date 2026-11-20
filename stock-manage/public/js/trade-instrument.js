const isHkFund = symbol => /^HK\d{10}$/i.test(symbol);
const isFund = symbol => /^\d{6}\.OF$/i.test(symbol) || isHkFund(symbol);

export function bindTradeInstrument(form, { resolve, assetTypes, accounts }) {
  const { symbol, name, currency, account_id: account, price } = form.elements;
  const status = form.querySelector('[data-instrument-status]');
  const choices = form.querySelector('[data-instrument-choices]');
  const priceLabel = form.querySelector('[data-trade-price-label]');
  const accountHint = form.querySelector('[data-trade-account-hint]');
  const type = form.elements.type;
  const key = () => symbol.value.trim().toUpperCase();
  let current = key();
  let manual = !!name.value.trim() && name.value.trim().toUpperCase() !== current;
  let lookup = manual ? { code: current, promise: Promise.resolve(true) } : null;
  let timer;
  let resolvedCurrency = '';

  function updateAccountHint() {
    if (!account) return;
    const selected = accounts.find(a => String(a.id) === account.value);
    const expected = type.value === 'other' ? currency.value : resolvedCurrency;
    const message = selected && expected && selected.currency !== expected
      ? `所选证券账户币种为 ${selected.currency}，请选择 ${expected} 证券账户。` : '';
    account.setCustomValidity(message);
    if (accountHint) accountHint.textContent = message;
  }

  function syncInstrument(code) {
    const fund = isFund(code);
    price.step = isHkFund(code) ? '0.00001' : fund ? '0.0001' : '0.001';
    priceLabel.textContent = fund ? '成交净值' : '价格';
    form.querySelector('[data-trade-shares-label]').textContent = fund ? '确认份额' : '数量';
  }

  function setResolvedCurrency(value) {
    resolvedCurrency = value;
    if (type.value !== 'other' && value) {
      currency.value = value;
      if (account && !account.value) {
        const matching = accounts.filter(a => a.currency === value);
        if (matching.length === 1) account.value = String(matching[0].id);
      }
    }
    updateAccountHint();
  }

  function inferUnresolvedCurrency(code) {
    if (/^(?:HK\.?)?\d{1,5}(?:\.HK)?$/.test(code)) return 'HKD';
    if (isFund(code) && !isHkFund(code) || /^(?:SH\.?|SZ\.?|SS\.?)?\d{6}(?:\.(?:SH|SZ|SS))?$/.test(code)) return 'CNY';
    return 'USD';
  }

  function apply(item) {
    form.dataset.resolvedSymbol = item.symbol;
    if (!manual) name.value = item.name;
    syncInstrument(item.symbol);
    setResolvedCurrency(item.currency);
    choices.replaceChildren();
    status.textContent = assetTypes[item.assetType] || '';
    lookup = { code: key(), promise: Promise.resolve(true) };
    form.dispatchEvent(new Event('instrument-resolved'));
  }

  function lookUp() {
    clearTimeout(timer);
    const code = key();
    if (!code || code === 'OTHER' || !form.isConnected) return Promise.resolve(true);
    if (lookup?.code === code) return lookup.promise;
    const request = { code };
    lookup = request;
    status.textContent = '正在识别代码…';
    const stillCurrent = () => form.isConnected && lookup === request && key() === code;
    request.promise = resolve(code).then(items => {
      if (!stillCurrent()) return false;
      if (items.length === 1) {
        apply(items[0]);
        return true;
      }
      if (items.length > 1) {
        status.textContent = '同一代码有多个标的，请选择';
        for (const item of items) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn ghost sm-btn-sm';
          button.textContent = `${assetTypes[item.assetType]} · ${item.name}`;
          button.addEventListener('click', () => apply(item));
          choices.append(button);
        }
        return false;
      }
      status.textContent = isHkFund(code) ? '暂未接入此香港基金份额' : /^\d{6}$/.test(code) && form.elements.type.value !== 'other'
        ? '未识别标的，请核对代码，或加上 .SH、.SZ、.OF 后重试'
        : '未查到名称，请核对代码或手动填写';
      lookup = null;
      const canContinue = (!isHkFund(code) && !/^\d{6}$/.test(code)) || type.value === 'other';
      if (canContinue && type.value !== 'other') setResolvedCurrency(inferUnresolvedCurrency(code));
      return canContinue;
    }).catch(error => {
      if (!stillCurrent()) return false;
      status.textContent = error.message;
      lookup = null;
      if (/万份收益/.test(error.message)) return false;
      const canContinue = (!isHkFund(code) && !/^\d{6}$/.test(code)) || type.value === 'other';
      if (canContinue && type.value !== 'other') setResolvedCurrency(inferUnresolvedCurrency(code));
      return canContinue;
    });
    return request.promise;
  }

  name.addEventListener('input', () => { manual = !!name.value.trim(); });
  symbol.addEventListener('input', () => {
    const code = key();
    if (code === current) return;
    current = code;
    lookup = null;
    delete form.dataset.resolvedSymbol;
    manual = false;
    name.value = '';
    choices.replaceChildren();
    status.textContent = '';
    resolvedCurrency = '';
    updateAccountHint();
    syncInstrument(code);
    clearTimeout(timer);
    timer = setTimeout(lookUp, 350);
  });
  symbol.addEventListener('blur', lookUp);
  type.addEventListener('change', () => setResolvedCurrency(resolvedCurrency));
  account?.addEventListener('change', updateAccountHint);
  currency.addEventListener('change', updateAccountHint);
  syncInstrument(current);
  if (current && manual) setResolvedCurrency(currency.value);
  if (current && !manual) lookUp();
  return lookUp;
}
