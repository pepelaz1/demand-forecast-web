import { importSales, importStocks, calculate, exportCsv } from './forecast.js';

const $ = id => document.getElementById(id);
let sales = [];
let stocks = new Map();
let importErrors = [];
let calculation = null;

function notice(text, error = false) {
  $('messages').textContent = text;
  $('messages').classList.toggle('error', error);
}

function parameters() {
  return {
    historyDays: Number($('history').value),
    horizonDays: Number($('horizon').value),
    defaultLeadDays: Number($('lead').value),
  };
}

function format(value, digits = 0) { return value == null ? '—' : value.toLocaleString('ru-RU', {minimumFractionDigits: digits, maximumFractionDigits: digits}); }
function productsCount(count) {
  const tail = count % 100;
  const unit = tail >= 11 && tail <= 14 ? 'товаров' : count % 10 === 1 ? 'товар' : count % 10 >= 2 && count % 10 <= 4 ? 'товара' : 'товаров';
  return `${count} ${unit}`;
}

function render() {
  if (!calculation) return;
  const { rows, latest } = calculation;
  $('reference-date').textContent = `Расчёт по продажам до ${latest}. Окно истории заканчивается последней датой в файле.`;
  $('metric-products').textContent = format(rows.length);
  $('metric-order').textContent = format(rows.reduce((sum, row) => sum + (row.order ?? 0), 0));
  $('metric-warning').textContent = format(rows.filter(row => row.warning).length);
  $('export').disabled = false;
  const term = $('search').value.trim().toLocaleLowerCase('ru');
  const list = rows.filter(row => row.sku.toLocaleLowerCase('ru').includes(term));
  if ($('sort').value === 'sku') list.sort((a, b) => a.sku.localeCompare(b.sku, 'ru'));
  else if ($('sort').value === 'sold') list.sort((a, b) => b.sold - a.sold || a.sku.localeCompare(b.sku, 'ru'));
  else list.sort((a, b) => (b.order ?? -1) - (a.order ?? -1) || a.sku.localeCompare(b.sku, 'ru'));
  const body = $('result-body');
  body.replaceChildren();
  if (!list.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 8; td.className = 'empty'; td.textContent = 'Ничего не найдено.'; tr.append(td); body.append(tr); return;
  }
  for (const row of list) {
    const tr = document.createElement('tr');
    const cells = [row.sku, format(row.sold), format(row.daily, 2), format(row.forecast, 1)];
    for (const value of cells) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    for (const [field, value, placeholder] of [['stock', row.stock, 'Остаток'], ['leadDays', stocks.get(row.sku)?.leadDays ?? null, `По умолч. ${parameters().defaultLeadDays}`]]) {
      const td = document.createElement('td'); const input = document.createElement('input');
      input.type = 'number'; input.min = field === 'stock' ? '0' : '1'; input.max = field === 'leadDays' ? '365' : '';
      input.className = 'cell-input'; input.value = value ?? ''; input.placeholder = placeholder;
      input.setAttribute('aria-label', `${field === 'stock' ? 'Остаток' : 'Срок поставки'} для ${row.sku}`);
      const updateValue = () => {
        const current = stocks.get(row.sku) || { stock: null, leadDays: null };
        if (input.value.trim() === '') current[field] = null;
        else {
          const number = Number(input.value);
          if (!Number.isSafeInteger(number) || number < Number(input.min) || (input.max && number > Number(input.max))) {
            notice(`Для ${row.sku} введите корректное значение поля «${field === 'stock' ? 'Остаток' : 'Срок поставки'}».`, true); return false;
          }
          current[field] = number;
        }
        stocks.set(row.sku, current);
        return true;
      };
      input.addEventListener('input', updateValue);
      input.addEventListener('blur', () => { if (updateValue()) recalculate(false); });
      td.append(input); tr.append(td);
    }
    const order = document.createElement('td'); order.textContent = format(row.order);
    if (row.order > 0) order.className = 'order-positive'; tr.append(order);
    const warning = document.createElement('td'); warning.textContent = row.warning || (row.order === 0 ? 'Запас покрывает срок поставки' : 'Средний спрос × срок поставки − остаток');
    warning.className = row.warning ? 'warning' : ''; tr.append(warning);
    body.append(tr);
  }
}

function recalculate(showMessage = true) {
  try {
    calculation = calculate(sales, stocks, parameters());
    render();
    if (showMessage) notice(`${productsCount(calculation.rows.length)} обработано. ${importErrors.length ? `Ошибок в файлах: ${importErrors.length}. ${importErrors[0]}` : 'Ошибок в файлах нет.'}`,
      importErrors.length > 0);
  } catch (error) { notice(error.message, true); }
}

async function readSales(file) {
  if (!file) return;
  try {
    const parsed = importSales(await file.text());
    sales = parsed.sales; importErrors = parsed.errors;
    $('sales-name').textContent = `${file.name} · ${sales.length} строк`;
    recalculate();
  } catch (error) { notice(`Продажи: ${error.message}`, true); }
}

async function readStocks(file) {
  if (!file) return;
  try {
    const parsed = importStocks(await file.text());
    stocks = parsed.stocks; importErrors.push(...parsed.errors);
    $('stocks-name').textContent = `${file.name} · ${stocks.size} товаров`;
    if (sales.length) recalculate(); else notice('Остатки загружены. Теперь загрузите продажи.');
  } catch (error) { notice(`Остатки: ${error.message}`, true); }
}

$('sales-file').addEventListener('change', event => readSales(event.target.files[0]));
$('stocks-file').addEventListener('change', event => readStocks(event.target.files[0]));
$('calculate').addEventListener('click', () => recalculate());
$('search').addEventListener('input', render);
$('sort').addEventListener('change', render);
$('export').addEventListener('click', () => {
  if (!calculation) return;
  const blob = new Blob([exportCsv(calculation.rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'demand-forecast.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('load-demo').addEventListener('click', async () => {
  try {
    const [salesResponse, stocksResponse] = await Promise.all([fetch('sample-sales.csv'), fetch('sample-stocks.csv')]);
    if (!salesResponse.ok || !stocksResponse.ok) throw new Error('Не удалось загрузить пример.');
    const salesData = importSales(await salesResponse.text());
    const stockData = importStocks(await stocksResponse.text());
    sales = salesData.sales; stocks = stockData.stocks; importErrors = [...salesData.errors, ...stockData.errors];
    $('sales-name').textContent = 'Пример продаж · ' + sales.length + ' строк';
    $('stocks-name').textContent = 'Пример остатков · ' + stocks.size + ' товаров';
    recalculate();
    $('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { notice(error.message, true); }
});
