// Intl formatters allocate ICU/native memory as well as JavaScript objects.
// Reuse formatters (never formatted dates), with a bound for variable time zones.
const formatters = new Map();
const MAX_FORMATTERS = 16;

export function dateTimeFormatter(locale, options) {
  const key = JSON.stringify([locale, options]);
  if (formatters.has(key)) return formatters.get(key);
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value);
  formatters.set(key, formatter);
  return formatter;
}
