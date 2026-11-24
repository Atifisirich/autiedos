#!/usr/bin/env node
/** Driver app: trip, GPS posted through erp.driver_position, boarding, delay, SOS; the parent then sees the bus live. */
import pg from '../../../packages/server/node_modules/pg/lib/index.js';
import { BASE, launch, openAs, reporter, shot, text, world } from './portal-lib.mjs';

const R = reporter('portal driver');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const browser = await launch();
const geolocation = { latitude: 17.3851, longitude: 78.4867 };
const d = await openAs(browser, 'driver@' + world.orgA.slice(0, 6) + '.erp.test', { permissions: ['geolocation'], geolocation });
const { page } = d;

await page.goto(`${BASE}/erp/driver`);
await page.getByText('Route 1').waitFor();
await shot(page, 'driver-routes');
R.ok(!(await text(page)).includes('Route 2'), 'only the assigned route is listed');
await page.getByRole('button', { name: 'Open running trip' }).click();
await page.getByTestId('driver-students').waitFor();
await page.getByTestId('gps-last').waitFor({ timeout: 30000 });
const [t] = await q(`select last_lat, last_lng, last_at from erp.trips where id = $1`, [world.erpA.trip1]);
R.ok(Number(t.last_lat) === geolocation.latitude && Number(t.last_lng) === geolocation.longitude, 'GPS position posted through erp.driver_position');
await page.getByRole('button', { name: 'Boarded' }).first().click();
for (let i = 0; i < 30; i++) { if ((await q(`select count(*)::int n from erp.trip_events where trip_id = $1 and type = 'boarded'`, [world.erpA.trip1]))[0].n >= 2) break; await new Promise((r) => setTimeout(r, 200)); }
R.ok((await q(`select count(*)::int n from erp.trip_events where trip_id = $1 and type = 'boarded' and student_id = $2`, [world.erpA.trip1, world.learnerA]))[0].n >= 2, 'boarding recorded');
await page.getByRole('button', { name: 'Running late' }).click();
await page.getByText('Parents were told the bus is late.').waitFor();
R.eq((await q(`select delay_minutes from erp.trips where id = $1`, [world.erpA.trip1]))[0].delay_minutes, 10, 'delay recorded');
page.once('dialog', (x) => x.accept());
await page.getByRole('button', { name: 'SOS' }).click();
await page.getByText('Alert sent to the school.').waitFor();
R.eq((await q(`select count(*)::int n from erp.trip_events where trip_id = $1 and type = 'sos'`, [world.erpA.trip1]))[0].n, 1, 'SOS event stored');
await shot(page, 'driver-trip');
R.problems(d.problems);

console.log('the parent sees the bus live');
const p = await openAs(browser, 'guardian@a.test');
await p.page.goto(`${BASE}/erp/parent/bus`);
await p.page.getByTestId('bus-marker').waitFor();
const t2 = await text(p.page);
R.ok(/Live/.test(t2) && /10 min late/.test(t2), 'live badge and delay shown');
await shot(p.page, 'parent-bus-live');
R.problems(p.problems);
await d.ctx.close(); await p.ctx.close(); await browser.close(); await db.end();
R.done();
