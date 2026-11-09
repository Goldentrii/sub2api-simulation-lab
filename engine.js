const dimensions = ['provider', 'model', 'role'];
const metrics = [
  'tokens', 'input', 'uncached', 'read', 'write', 'output',
  'requests', 'images', 'cost', 'baseline', 'charge', 'savings',
];
const inputKeys = ['uncached', 'read', 'write', 'output'];
const sourceFields = {
  uncached: 'uncached_input_tokens',
  read: 'cache_read_tokens',
  write: 'cache_write_tokens',
  output: 'output_tokens',
  requests: 'estimated_requests',
  images: 'estimated_image_requests',
  cost: 'upstream_usd_cents',
  baseline: 'upstream_without_cache_usd_cents',
  charge: 'scenario_charge_usd_cents',
};
const highRoles = new Set(['premium', 'pro', 'thinking']);
const allowedGrains = new Set(['hour', 'day', 'week', 'month']);

export function isHighRole(role) {
  return highRoles.has(role);
}

function normalizedMetrics(readSource) {
  const values = Object.fromEntries(
    Object.entries(sourceFields).map(([key, field]) => [key, readSource(field)]),
  );
  // Some source allocations exceeded the input cap when adding read and write.
  // Reclassify the excess reads so the input total and source USD are preserved.
  if (values.uncached < 0) {
    values.read += values.uncached;
    values.uncached = 0;
  }
  if (Object.values(values).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Usage snapshot has an invalid count or amount.');
  }
  values.input = values.uncached + values.read + values.write;
  values.tokens = values.input + values.output;
  values.savings = values.baseline - values.cost;
  return values;
}

export function prepare(dailyPayload, hourlyPayload) {
  const daily = [];
  const dailyById = new Map();
  const correction = {rows: 0, readTokens: 0};
  for (const row of dailyPayload.daily_usage) {
    if (row.uncached_input_tokens < 0) {
      correction.rows += 1;
      correction.readTokens -= row.uncached_input_tokens;
    }
    const normalized = {
      day: row.date,
      hour: null,
      provider: row.provider,
      model: row.model,
      modelId: row.model_id ?? '',
      rates: [row.input_usd_per_mtok,row.output_usd_per_mtok,row.cache_read_usd_per_mtok,row.cache_write_usd_per_mtok],
      role: row.model_role,
      segment: row.scenario_segment,
      status: row.data_status,
      pricingEvidence: row.pricing_evidence,
      pricingSource: row.pricing_source,
      release: row.model_release_date,
      adoption: row.scenario_adoption_date,
      dailyId: row.daily_row_id,
      ...normalizedMetrics(field => row[field]),
    };
    daily.push(normalized);
    dailyById.set(row.daily_row_id, normalized);
  }
  const hourly = [];
  if (hourlyPayload) {
    const columns = new Map(hourlyPayload.columns.map((name, i) => [name, i]));
    for (const row of hourlyPayload.hourly_usage) {
      const parent = dailyById.get(row[columns.get('daily_row_id')]);
      if (!parent) throw new Error('Hourly snapshot refers to a missing daily record.');
      hourly.push({
        ...parent,
        ...normalizedMetrics(field => row[columns.get(field)]),
        hour: row[columns.get('hour_start_utc')],
      });
    }
    hourly.sort((a, b) => a.hour.localeCompare(b.hour));
  }
  const options = Object.fromEntries(dimensions.map(key => [
    key + 's', [...new Set(daily.map(row => row[key]))].sort(),
  ]));
  const [from, to] = dailyPayload.date_range;
  return {daily, hourly, from, to, correction, ...options};
}

export function query(rows, options = {}) {
  const {from, to} = options;
  const filters = dimensions.map(key => [
    key, options[key + 's'] == null ? null : new Set(options[key + 's']),
  ]);
  return rows.filter(row =>
    (!from || row.day >= from) &&
    (!to || row.day <= to) &&
    filters.every(([key, selected]) => selected === null || selected.has(row[key])),
  );
}

function newTotals() {
  return {
    tokens: 0, input: 0, uncached: 0, read: 0, write: 0, output: 0,
    requests: 0, images: 0, cost: 0, baseline: 0, charge: 0, savings: 0, highTokens: 0,
  };
}

function add(totals, row) {
  for (const key of metrics) totals[key] += row[key];
  if (isHighRole(row.role)) totals.highTokens += row.tokens;
}

function finalize(totals) {
  return {
    ...totals,
    cacheHit: totals.input ? totals.read / totals.input : 0,
    highShare: totals.tokens ? totals.highTokens / totals.tokens : 0,
  };
}

export function summarize(rows) {
  const totals = newTotals();
  for (const row of rows) add(totals, row);
  return finalize(totals);
}

function weekStart(day) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

export function group(rows, grain) {
  if (!allowedGrains.has(grain)) throw new Error('Unknown time grain: ' + grain);
  const buckets = new Map();
  const weekByDay = new Map();
  for (const row of rows) {
    let key = row.day;
    if (grain === 'hour') key = row.hour;
    if (grain === 'month') key = row.day.slice(0, 7);
    if (grain === 'week') {
      if (!weekByDay.has(row.day)) weekByDay.set(row.day, weekStart(row.day));
      key = weekByDay.get(row.day);
    }
    if (key == null) throw new Error('Hourly grouping requires hourly records.');
    if (!buckets.has(key)) buckets.set(key, newTotals());
    add(buckets.get(key), row);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, totals]) => ({key, ...finalize(totals)}));
}

export function modelBreakdown(rows) {
  const models = new Map();
  for (const row of rows) {
    const key = JSON.stringify(dimensions.map(dimension => row[dimension]));
    if (!models.has(key)) {
      models.set(key, {provider: row.provider, model: row.model, role: row.role, totals: newTotals()});
    }
    add(models.get(key).totals, row);
  }
  return [...models.values()].map(({totals, ...dimensions}) => ({...dimensions, ...finalize(totals)}))
    .sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function allocate(total, weights) {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weightSum) return weights.map(() => 0);
  const exact = weights.map(weight => total * (weight / weightSum));
  const result = exact.map(Math.floor);
  const remaining = total - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({index, fraction: value - result[index]}));
  order.sort((a, b) => b.fraction - a.fraction);
  for (const {index} of order.slice(0, remaining)) result[index] += 1;
  return result;
}

function scale(row, tokens) {
  if (row.tokens === tokens) return row;
  const ratio = tokens / row.tokens;
  const [uncached, read, write, output] = allocate(tokens, inputKeys.map(key => row[key]));
  const requests = Math.round(row.requests * ratio);
  const cost = Math.round(row.cost * ratio);
  const baseline = Math.round(row.baseline * ratio);
  return {
    ...row, tokens, uncached, read, write, output, input: uncached + read + write,
    requests, images: Math.min(requests, Math.round(row.images * ratio)),
    cost, baseline, charge: Math.round(row.charge * ratio), savings: baseline - cost,
  };
}

export function simulate(rows, targets, granularity = 'day') {
  if (granularity !== 'day' && granularity !== 'hour') {
    throw new Error('Simulation granularity must be day or hour.');
  }
  const buckets = new Map();
  const result = rows.slice();
  let singleRoleTokens = 0;
  for (const [index, row] of rows.entries()) {
    if (!Number.isFinite(targets[row.provider]) || row.tokens === 0) continue;
    const time = granularity === 'hour' ? row.hour : row.day;
    if (time == null) throw new Error('Hourly simulation requires hourly records.');
    const key = time + '\u0000' + row.provider;
    if (!buckets.has(key)) buckets.set(key, {provider: row.provider, high: [], low: [], total: 0});
    const bucket = buckets.get(key);
    bucket[isHighRole(row.role) ? 'high' : 'low'].push({index, row});
    bucket.total += row.tokens;
  }
  for (const {provider, high, low, total} of buckets.values()) {
    if (!high.length || !low.length) {
      singleRoleTokens += total;
      continue;
    }
    const share = Math.max(0, Math.min(1, targets[provider]));
    const highTokens = Math.round(total * share);
    for (const [partition, partitionTokens] of [[high, highTokens], [low, total - highTokens]]) {
      const allocated = allocate(partitionTokens, partition.map(({row}) => row.tokens));
      partition.forEach(({index, row}, i) => { result[index] = scale(row, allocated[i]); });
    }
  }
  return {rows: result, singleRoleTokens};
}


