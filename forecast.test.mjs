import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importSales, importStocks, calculate, exportCsv } from './forecast.js';

const sampleSales = readFileSync(new URL('./sample-sales.csv', import.meta.url), 'utf8');
const sampleStocks = readFileSync(new URL('./sample-stocks.csv', import.meta.url), 'utf8');

test('forecast and order follow the brief, including stock-only products', () => {
  const { sales, errors } = importSales(sampleSales);
  const { stocks } = importStocks(sampleStocks);
  assert.equal(errors.length, 0);
  const result = calculate(sales, stocks);
  assert.equal(result.latest, '2026-11-03');
  assert.equal(result.insufficientHistory, false);
  const coffee = result.rows.find(row => row.sku.startsWith('Кофе'));
  assert.equal(coffee.sold, 40);
  assert.equal(coffee.forecast, 10);
  assert.equal(coffee.order, 7);
  const biscuit = result.rows.find(row => row.sku === 'Печенье овсяное');
  assert.equal(biscuit.sold, 0);
  assert.equal(biscuit.order, 0);
});

test('short history and missing stock prevent a reliable order', () => {
  const { sales } = importSales('date,sku,quantity\n2026-11-03,A,4');
  const result = calculate(sales, new Map());
  assert.equal(result.rows[0].forecast, 1);
  assert.equal(result.rows[0].order, null);
  assert.match(result.rows[0].warning, /История короче/);
});

test('invalid date and quantity report the source row', () => {
  const parsed = importSales('date,sku,quantity\n2026-11-03,A,2\n2026-02-30,B,3\n2026-11-02,C,-1');
  assert.equal(parsed.sales.length, 1);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0], /Строка 3/);
});

test('quoted CSV and export remain readable', () => {
  const { sales } = importSales('date;sku;quantity\n2026-11-01;"Чай; зелёный";3\n2026-11-28;"Чай; зелёный";2');
  const { stocks } = importStocks('sku;stock;lead_days\n"Чай; зелёный";0;7');
  const result = calculate(sales, stocks);
  assert.equal(result.rows[0].order, 2);
  assert.match(exportCsv(result.rows), /"Чай; зелёный"/);
});

test('large input does not exceed argument limits', () => {
  const lines = ['date,sku,quantity'];
  for (let i = 0; i < 1000; i++) for (let day = 1; day <= 365; day++) {
    const date = new Date(Date.UTC(2025, 0, day)).toISOString().slice(0, 10);
    lines.push(`${date},SKU-${i},1`);
  }
  const { sales } = importSales(lines.join('\n'));
  const result = calculate(sales, new Map(), { historyDays: 28 });
  assert.equal(result.rows.length, 1000);
  assert.equal(result.rows[0].sold, 28);
});
