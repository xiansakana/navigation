export const SOCIAL_ACCOUNT_GROUP = '社保公积金等';

export function analyticsScope(accounts, preferences = {}) {
  const options=accounts.filter(a=>a.group===SOCIAL_ACCOUNT_GROUP);
  const selected=preferences.accountIds==null?options.map(a=>a.id):options.filter(a=>preferences.accountIds.includes(a.id)).map(a=>a.id);
  return {enabled:preferences.enabled===true,selectedAccountIds:selected,excludedAccountIds:preferences.enabled===true?selected:[],options:options.map(a=>({id:a.id,name:a.name}))};
}

// Transfers are not income/expense; their fee belongs to the paying account.
export const scopedBills = (entries, excluded) => entries.filter(e=>!excluded.has(e.accountId));
