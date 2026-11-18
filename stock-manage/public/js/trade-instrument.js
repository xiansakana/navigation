const isFund = symbol => /^\d{6}\.OF$/i.test(symbol);

export function bindTradeInstrument(form, { resolve, assetTypes, accounts }) {
  const { symbol, name, currency, account_id: account, price } = form.elements;
  const status = form.querySelector('[data-instrument-status]');
  const choices = form.querySelector('[data-instrument-choices]');
  const priceLabel = form.querySelector('[data-trade-price-label]');
  const key = () => symbol.value.trim().toUpperCase();
  let current = key();
  let manual = !!name.value.trim() && name.value.trim().toUpperCase() !== current;
  let lookup = manual ? { code: current, promise: Promise.resolve(true) } : null;
  let timer;

  function syncInstrument(code, suggestedCurrency) {
    const fund = isFund(code);
    const hk = /^(?:HK\.?)?\d{1,5}(?:\.HK)?$/.test(code);
    const cn = /^(?:SH\.?|SZ\.?|SS\.?)?\d{6}(?:\.(?:SH|SZ|SS))?$/.test(code);
    if (form.elements.type.value !== 'other' && code) {
      currency.value = suggestedCurrency || (hk ? 'HKD' : cn || fund ? 'CNY' : 'USD');
      if (account && accounts.find(a => a.id === account.value)?.currency !== currency.value) {
        const matching = accounts.filter(a => a.currency === currency.value);
        account.value = matching.length === 1 ? matching[0].id : '';
      }
    }
    price.step = fund ? '0.0001' : '0.001';
    priceLabel.textContent = fund ? '成交净值' : '价格';
    form.querySelector('[data-trade-shares-label]').textContent = fund ? '确认份额' : '数量';
  }

  function apply(item) {
    form.dataset.resolvedSymbol = item.symbol;
    if (!manual) name.value = item.name;
    syncInstrument(item.symbol, item.currency);
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
      status.textContent = /^\d{6}$/.test(code) && form.elements.type.value !== 'other'
        ? '未识别标的，请核对代码，或加上 .SH、.SZ、.OF 后重试'
        : '未查到名称，请核对代码或手动填写';
      lookup = null;
      return !/^\d{6}$/.test(code) || form.elements.type.value === 'other';
    }).catch(error => {
      if (!stillCurrent()) return false;
      status.textContent = error.message;
      lookup = null;
      if (/万份收益/.test(error.message)) return false;
      return !/^\d{6}$/.test(code) || form.elements.type.value === 'other';
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
    syncInstrument(code);
    clearTimeout(timer);
    timer = setTimeout(lookUp, 350);
  });
  symbol.addEventListener('blur', lookUp);
  form.elements.type.addEventListener('change', () => syncInstrument(form.dataset.resolvedSymbol || key()));
  syncInstrument(current);
  if (current && !manual) lookUp();
  return lookUp;
}
