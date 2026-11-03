const salesAliases = {
  date: ['date', 'дата'],
  sku: ['sku', 'товар', 'название'],
  quantity: ['quantity', 'qty', 'количество'],
};
const stockAliases = {
  sku: salesAliases.sku,
  stock: ['stock', 'остаток'],
  leadDays: ['lead_days', 'срок_поставки', 'срок поставки'],
};

export function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error('Незакрытая кавычка в CSV.');
  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  if (!rows.length) throw new Error('CSV-файл пуст.');
  return rows;
}

function indexes(header, aliases, required) {
  const normalized = header.map(value => value.trim().toLowerCase());
  const index = Object.fromEntries(Object.entries(aliases).map(([key, names]) =>
    [key, normalized.findIndex(value => names.includes(value))]));
  const missing = required.filter(key => index[key] < 0);
  if (missing.length) throw new Error(`Не найдены обязательные колонки: ${missing.join(', ')}.`);
  return index;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp / 86400000;
}

function nonnegativeInt(value) {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function importSales(text) {
  const [header, ...body] = parseCsv(text);
  const index = indexes(header, salesAliases, ['date', 'sku', 'quantity']);
  const errors = [];
  const sales = [];
  body.forEach((row, offset) => {
    const date = validDate(row[index.date] || '');
    const sku = (row[index.sku] || '').trim();
    const quantity = nonnegativeInt(row[index.quantity] || '');
    if (date === null || !sku || quantity === null) {
      errors.push(`Строка ${offset + 2}: нужны дата ГГГГ-ММ-ДД, товар и целое количество от 0.`);
      return;
    }
    sales.push({ date, sku, quantity });
  });
  if (!sales.length) throw new Error('Нет корректных строк продаж. ' + (errors[0] || ''));
  if (new Set(sales.map(row => row.sku)).size > 1000) errors.push('Больше 1000 товаров: скорость работы не гарантируется.');
  let earliest = Infinity, latest = -Infinity;
  for (const sale of sales) { earliest = Math.min(earliest, sale.date); latest = Math.max(latest, sale.date); }
  return { sales, errors, earliest, latest };
}

export function importStocks(text) {
  const [header, ...body] = parseCsv(text);
  const index = indexes(header, stockAliases, ['sku', 'stock']);
  const errors = [];
  const stocks = new Map();
  body.forEach((row, offset) => {
    const sku = (row[index.sku] || '').trim();
    const stock = nonnegativeInt(row[index.stock] || '');
    const leadRaw = index.leadDays >= 0 ? (row[index.leadDays] || '').trim() : '';
    const leadDays = leadRaw ? nonnegativeInt(leadRaw) : null;
    if (!sku || stock === null || (leadRaw && (!leadDays || leadDays > 365))) {
      errors.push(`Строка ${offset + 2}: нужны товар, остаток от 0 и срок поставки от 1 до 365 дней.`);
      return;
    }
    if (stocks.has(sku)) { errors.push(`Строка ${offset + 2}: повтор товара «${sku}».`); return; }
    stocks.set(sku, { stock, leadDays });
  });
  return { stocks, errors };
}

export function calculate(sales, stocks, { historyDays = 28, horizonDays = 7, defaultLeadDays = 7 } = {}) {
  for (const [name, value, max] of [['история', historyDays, 366], ['горизонт', horizonDays, 365], ['срок поставки', defaultLeadDays, 365]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Параметр «${name}» должен быть целым числом от 1 до ${max}.`);
  }
  if (!sales.length) throw new Error('Сначала загрузите продажи.');
  let latest = -Infinity, earliest = Infinity;
  for (const sale of sales) { latest = Math.max(latest, sale.date); earliest = Math.min(earliest, sale.date); }
  const insufficientHistory = latest - earliest + 1 < historyDays;
  const grouped = new Map();
  for (const sale of sales) {
    if (!grouped.has(sale.sku)) grouped.set(sale.sku, 0);
    if (sale.date > latest - historyDays && sale.date <= latest) grouped.set(sale.sku, grouped.get(sale.sku) + sale.quantity);
  }
  for (const sku of stocks.keys()) if (!grouped.has(sku)) grouped.set(sku, 0);
  const rows = [...grouped].map(([sku, sold]) => {
    const daily = sold / historyDays;
    const forecast = Math.round((daily * horizonDays + Number.EPSILON) * 10) / 10;
    const item = stocks.get(sku);
    const stock = item?.stock ?? null;
    const leadDays = item?.leadDays ?? defaultLeadDays;
    const warnings = [];
    if (insufficientHistory) warnings.push('История короче выбранного окна');
    if (stock === null) warnings.push('Не указан остаток');
    const order = warnings.length ? null : Math.max(0, Math.ceil(daily * leadDays - stock - 1e-9));
    return { sku, sold, daily, forecast, stock, leadDays, order, warning: warnings.join('; ') };
  });
  rows.sort((a, b) => (b.order ?? -1) - (a.order ?? -1) || a.sku.localeCompare(b.sku, 'ru'));
  return { rows, latest: new Date(latest * 86400000).toISOString().slice(0, 10), insufficientHistory };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportCsv(rows) {
  const header = ['sku', 'sold', 'daily_demand', 'forecast', 'stock', 'lead_days', 'to_order', 'warning'];
  return '\uFEFF' + [header, ...rows.map(row => [row.sku, row.sold, row.daily.toFixed(2), row.forecast.toFixed(1),
    row.stock, row.leadDays, row.order, row.warning])].map(line => line.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
