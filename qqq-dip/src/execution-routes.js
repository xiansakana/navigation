import { legsToTradeInputs, appendTradesApplyCash } from '../../shared/db/portfolio-bridge.js';
import { marketStatus } from './market-hours.js';
import { resetRound, buildBuyPreview, applyRoundFromEval } from './playbook.js';
import { syncCnyPlan } from './cny-routing.js';
import { prepareExecution, canExecutePlan, canSpendDipFunds, commitExecution, captureExecutionPlan } from './execution-plan.js';
import { createExecutionDefaultsHandler } from './execution-defaults.js';

export function registerExecutionRoutes(app, {
  store, quotes, liveEval, refreshEvaluation, hasDipPermission, requireDip,
  canViewActions, visibleActions, canViewFunds, canViewLots
}) {
  app.get('/api/actions', async (req, res) => {
    if (!canViewActions(req)) return res.status(403).json({ error: '无权查看操作记录' });
    res.json(visibleActions(req, await store.listActionRows({
      limit: Number(req.query.limit) || 20,
      offset: Number(req.query.offset) || 0,
      source: String(req.query.source || 'all')
    })));
  });

  app.get('/api/execution-plans/:tier/defaults', requireDip('tier-exec', 'edit'), (req, res, next) => {
    if (canViewFunds(req) && canViewLots(req)) return next();
    return res.status(403).json({ error: '无权查看成交计划的资金与仓位' });
  }, createExecutionDefaultsHandler({ store, quotes }));

  async function refreshCnyQuotes() {
    const result = await Promise.all(['159509', '513850', '161128'].map(async (symbol) => {
      try { return [symbol, await quotes.getCnyFundQuote(symbol)]; }
      catch (error) { return [symbol, { symbol, navError: error.message }]; }
    }));
    const previous = await store.getQuotes();
    const current = Object.fromEntries(result.map(([s, q]) => [s, { ...q, candles: previous[s]?.candles || [] }]));
    await store.setQuotes({ ...previous, ...current });
    return current;
  }

  app.post('/api/actions', async (req, res) => {
    const body = req.body || {};
    let syncedTrades = [];

    const executesTrade = ['execute', 'sell'].includes(body.type)
      || (Array.isArray(body.legs) && body.legs.some(leg => String(leg?.side || '').toLowerCase() === 'sell'));
    if (executesTrade && !canExecutePlan(req.headers['x-portal-permissions'])) {
      return res.status(403).json({ error: '无档位成交登记权限' });
    }
    if (!executesTrade && !hasDipPermission(req, 'actions-note', 'edit')) {
      return res.status(403).json({ error: '无权添加操作记录' });
    }
    if (body.type === 'execute' && body.operation === 'cancel') {
      const round = await store.getRound();
      const plan = round.executionPlans?.[body.tier];
      if (!plan || plan.id !== body.planId || plan.inFlight) return res.status(409).json({ error: '计划不存在或写入待核对' });
      plan.cancelled = true;
      await store.setRound(round);
      await store.addAction({ type: 'note', source: 'user', tier: body.tier, message: '取消未成交计划；已成交持仓及扣款不撤销' });
      return res.json({ ok: true, evaluation: await refreshEvaluation() });
    }

    if (body.type === 'execute' && body.operation === 'create') {
      if (!canSpendDipFunds(req.headers['x-portal-permissions'])) return res.status(403).json({ error: '无抄底专用资金成交权限' });
      if (!/^T[1-7]$/.test(body.tier || '')) return res.status(400).json({ error: '仅支持为 T1–T7 建立盘中正股计划' });
      const ev = await liveEval();
      const round = await store.getRound();
      if (round.executionPlans?.[body.tier]) return res.json({ ok: true, evaluation: ev });
      if (ev.sameDaySkip.includes(body.tier)) return res.status(409).json({ error: '本档已被同日更深档覆盖' });
      const preview = buildBuyPreview({ ...ev, primary: { ...ev.primary, tier: body.tier } }, ev.suggestedContracts);
      if (!preview.pendingClose || !preview.equityMarket) return res.status(409).json({ error: '当前未满足盘中正股计划条件' });
      const next = captureExecutionPlan(round, preview, new Date(), { manual: true });
      if (next === round) return res.status(409).json({ error: '当前无可执行的正股计划，请核对最新报价、市场时段及预算' });
      await store.setRound(applyRoundFromEval(next, { ...ev, budgetLocked: true }, { sessionDate: marketStatus().ymd }));
      return res.json({ ok: true, evaluation: await refreshEvaluation() });
    }

    if (body.type === 'execute' && ['refresh-cny', 'sync-cny'].includes(body.operation)) {
      if (!canViewFunds(req) || !canViewLots(req) || !canSpendDipFunds(req.headers['x-portal-permissions'])
        || (body.operation === 'refresh-cny' && !hasDipPermission(req, 'cny-routing', 'edit'))) {
        return res.status(403).json({ error: '无权调整人民币抄底标的' });
      }
      try {
        const round = await store.getRound();
        const plan = structuredClone(round.executionPlans?.[body.tier]);
        if (!plan || plan.id !== body.planId) return res.status(409).json({ error: '计划已变化' });
        const quotesBySymbol = await refreshCnyQuotes();
        const next = syncCnyPlan(plan, quotesBySymbol);
        // Re-read after network I/O so concurrent fills cannot be overwritten.
        const current = await store.getRound();
        if (JSON.stringify(current.executionPlans?.[body.tier]) !== JSON.stringify(plan)) {
          return res.status(409).json({ error: '计划已变化，请重新打开' });
        }
        if (next === plan) return res.json({ ok: true, evaluation: await refreshEvaluation() });
        current.executionPlans[body.tier] = next;
        await store.setRound(current);
        await store.addAction({ type: 'note', source: 'user', tier: body.tier,
          message: '按25%/10%溢价规则更新未成交人民币预算，已有成交不变',
          payload: { revision: next.cnyRevision } });
        return res.json({ ok: true, evaluation: await refreshEvaluation() });
      } catch (error) { return res.status(409).json({ error: error.message }); }
    }

    if (body.type === 'execute' && body.tier) {
      if (!canSpendDipFunds(req.headers['x-portal-permissions'])) return res.status(403).json({ error: '无抄底专用资金成交权限' });
      let prepared;
      const executionRound = await store.getRound();
      try {
        const fillsCny = body.fills?.some((fill) => executionRound.executionPlans?.[body.tier]?.legs
          .some((leg) => leg.id === fill.legId && leg.currency === 'CNY'));
        if (fillsCny) {
          await refreshCnyQuotes();
          const latestRound = await store.getRound();
          if (JSON.stringify(latestRound.executionPlans?.[body.tier]) !== JSON.stringify(executionRound.executionPlans?.[body.tier])) {
            return res.status(409).json({ error: '计划已变化，请重新打开' });
          }
        }
        prepared = prepareExecution(executionRound.executionPlans?.[body.tier], body, await liveEval(), await store.getCash());
      } catch (error) { return res.status(409).json({ error: error.message }); }
      if (prepared.duplicate) return res.json({ ok: true, duplicate: true, evaluation: await refreshEvaluation() });
      const cashState = await store.getCash();
      const fund = cashState.strategyFunds?.find((f) => f.accountId === body.accountId);
      if (!fund || fund.deficit > 0 || prepared.legs.some((leg) => leg.currency !== fund.currency)
        || (prepared.cashUsd + prepared.cashCny) > fund.strategyAvailable + 0.01) {
        return res.status(409).json({ error: '请选择同币种、有足额抄底预留且无缺口的证券账户，每次仅登记同一账户的成交' });
      }
      const { cashUsd, cashCny, legs } = prepared;
      const tradeInputs = legsToTradeInputs(legs, {
        tier: body.tier,
        note: [prepared.intradayEquity ? '盘中触价正股成交' : '', body.note].filter(Boolean).join(' · '),
        trade_date: prepared.filledAt
      });
      const buyInputs = tradeInputs.filter((t) => t.type !== 'sell');
      const sellInputs = tradeInputs.filter((t) => t.type === 'sell');
      if (buyInputs.length !== legs.length || sellInputs.length) return res.status(409).json({ error: '成交明细无效，不扣现金' });

      try {
        const result = await commitExecution(store, body, prepared, () => appendTradesApplyCash(
          buyInputs.map((trade) => ({ ...trade, account_id: body.accountId })), { strategyFundId: body.accountId }));
        syncedTrades = syncedTrades.concat(result.trades);
      } catch (error) { return res.status(409).json({ error: `成交同步未完成，请核对账本后处理：${error.message}` }); }
      body.legs = legs;
      body.cashUsd = cashUsd;
      body.cashCny = cashCny;
      body.usd = prepared.usd;
    } else if (body.type === 'sell') {
      const symbol = String(body.symbol || '').trim();
      const shares = Number(body.shares);
      const price = Number(body.price);
      if (symbol && shares > 0 && price > 0) {
        const result = await appendTradesApplyCash([{
          type: 'sell',
          symbol,
          name: body.name || symbol,
          currency: body.currency,
          shares,
          price,
          commission: Number(body.commission) || 0,
          trade_date: body.trade_date || new Date().toISOString(),
          source: 'qqq-dip',
          note: body.note || body.message || ''
        }]);
        syncedTrades = result.trades;
      }
    } else if (Array.isArray(body.legs) && body.legs.some((l) => String(l?.side || '').toLowerCase() === 'sell')) {
      const tradeInputs = legsToTradeInputs(body.legs, {
        note: body.note || body.message || '',
        trade_date: new Date().toISOString()
      });
      const sellInputs = tradeInputs.filter((t) => t.type === 'sell');
      if (sellInputs.length) {
        const result = await appendTradesApplyCash(sellInputs);
        syncedTrades = result.trades;
      }
    }

    const cash = await store.getCash();
    const row = await store.addAction({
      type: body.type || 'note',
      source: 'user',
      tier: body.tier || null,
      symbol: body.symbol || null,
      message: body.message || '手动记录',
      payload: body.payload || {
        usd: body.usd,
        cashUsd: body.cashUsd,
        cashCny: body.cashCny,
        qty: body.qty,
        price: body.price,
        shares: body.shares,
        currency: body.currency,
        note: body.note,
        legs: body.legs,
        syncedTradeIds: syncedTrades.map((t) => t.id)
      }
    });
    res.json({
      ok: true,
      action: row,
      cash,
      round: await store.getRound(),
      evaluation: await refreshEvaluation(),
      actions: await store.listActionRows({ limit: 20 }),
      syncedTrades
    });
  });

  app.put('/api/actions/:id', requireDip('actions-note', 'edit'), async (req, res) => {
    const row = await store.patchAction(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: '记录不存在' });
    res.json({ ok: true, action: row });
  });

  app.get('/api/lots', async (req, res) => canViewLots(req)
    ? res.json({ lots: await store.getLots() }) : res.status(403).json({ error: '无权查看仓位' }));

  app.post('/api/lots', requireDip('lots-edit', 'edit'), async (req, res) => {
    const lot = await store.saveLot(req.body || {});
    await store.addAction({
      type: 'note',
      source: 'user',
      symbol: lot.symbol,
      message: `登记抄底仓位 ${lot.symbol || lot.id}`
    });
    res.json({ ok: true, lot, evaluation: await refreshEvaluation() });
  });

  app.put('/api/lots/:id', requireDip('lots-edit', 'edit'), async (req, res) => {
    const lot = await store.saveLot({ ...(req.body || {}), id: req.params.id });
    res.json({ ok: true, lot, evaluation: await refreshEvaluation() });
  });

  app.delete('/api/lots/:id', requireDip('lots-edit', 'edit'), async (req, res) => {
    await store.removeLot(req.params.id);
    res.json({ ok: true, evaluation: await refreshEvaluation() });
  });

  app.post('/api/round/reset', requireDip('tier-exec', 'edit'), async (_req, res) => {
    const prev = await store.getRound();
    await store.setRound(resetRound(prev));
    await store.addAction({ type: 'note', source: 'user', message: '手动结束本轮，清空档位状态；保留真实持仓、现金和历史操作' });
    res.json({ ok: true, round: await store.getRound(), evaluation: await refreshEvaluation() });
  });
}
