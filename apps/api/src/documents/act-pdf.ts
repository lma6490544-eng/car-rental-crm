import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { VehicleSnapshot } from './booking-documents';
import type { InspectionKind, Lessor } from './document.dto';
import { escape } from './contract-pdf';
import { renderPdf } from './render-pdf';

export const actTemplateVersion = '464-cx-v1';

export type ActSnapshot = {
  kind: InspectionKind;
  vehicle: VehicleSnapshot;
  mileageKm: number;
  fuelEighths: number;
  noDamage: boolean;
  damageNotes: string;
  specialNotes: string;
  inspectedAt: string;
  customerName: string;
  customerSigner: string;
  lessor: Lessor;
};

const equipment = [
  'Щётки стеклоочистителя',
  'Зеркало заднего вида',
  'Колёсный ключ',
  'Зеркало боковое',
  'Домкрат',
  'Запасное колесо',
  'Антенна',
  'Магнитола',
  'Пепельница',
  'Прикуриватель',
  'Резиновые коврики',
  'Подголовники',
  'Аптечка',
  'Ремни безопасности',
  'Огнетушитель',
  'Знак аварийной остановки',
  'Щётка со скребком для снега',
  'Свидетельство о регистрации ТС',
  'Съёмная панель для магнитолы',
  'Покрышки шипованные',
  'Талон ГТО',
  'Пробка бензобака',
  'Правила страхования',
  'Комплект ключей (ключ зажигания, ключ замков дверей и багажника, ключ иммобилизатора)',
];
const dateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
  timeStyle: 'short',
});

export async function renderAct(
  bookingId: number,
  revision: number,
  templateVersion: string,
  snapshot: ActSnapshot,
) {
  if (templateVersion !== actTemplateVersion) throw new Error('Unknown act template version');
  const diagram = await readFile(
    resolve(__dirname, '../../assets/inspection-act-diagram.jpg'),
    'base64',
  );
  const { vehicle, lessor } = snapshot;
  const pickup = snapshot.kind === 'pickup';
  return renderPdf(`<!doctype html><html lang="ru"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
    <title>Акт приёма-передачи к договору № ${bookingId}</title>
    <style>
      @page { size:A4; margin:12mm 15mm 13mm; @bottom-right { content:"Стр. " counter(page) " из " counter(pages); font:8pt Arial; } }
      body { font:9.5pt/1.22 Arial,sans-serif; color:#111; overflow-wrap:anywhere; }
      h1 { font-size:15pt; text-align:center; margin:0 0 4pt; }
      h2 { font-size:11pt; margin:7pt 0 3pt; break-after:avoid; }
      p { margin:3pt 0; orphans:2; widows:2; }
      .reference { text-align:center; margin-bottom:9pt; }
      table { width:100%; border-collapse:collapse; table-layout:fixed; }
      th,td { border:.6pt solid #444; text-align:left; padding:2.5pt 5pt; vertical-align:top; }
      th { width:30%; }
      tr { break-inside:avoid; }
      .equipment { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:2pt 8pt; }
      .equipment div { display:flex; gap:4pt; align-items:flex-start; break-inside:avoid; }
      .check { width:8pt; height:8pt; border:.65pt solid #111; flex:none; margin-top:1pt; }
      .damage-diagram { display:block; width:82%; max-height:66mm; object-fit:contain; margin:4pt auto; }
      .notes { white-space:pre-wrap; border-bottom:.55pt solid #777; padding:2pt 0; }
      .signatures { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12pt; margin-top:12pt; break-inside:avoid; }
      .line { border-bottom:1pt solid; margin:15pt 0 2pt; }
    </style><body>
    <h1>Акт приёма-передачи автомобиля</h1>
    <p class="reference">К договору № ${bookingId} · ${pickup ? 'Выдача' : 'Приёмка'} · осмотр, редакция ${revision}</p>
    <p><b>Место и время осмотра:</b> Санкт-Петербург, ${escape(dateTime.format(new Date(snapshot.inspectedAt)))}</p>
    <p><b>Арендодатель:</b> ${escape(lessor.name)}</p>
    <p><b>Арендатор:</b> ${escape(snapshot.customerName)}</p>
    <table>
      <tr><th>Автомобиль</th><td>${escape(vehicle.brand + ' ' + vehicle.model)}, ${vehicle.year} г.</td></tr>
      <tr><th>Госномер и VIN</th><td>${escape(vehicle.plate)} · ${escape(vehicle.vin ?? '—')}</td></tr>
      <tr><th>Пробег по одометру</th><td>${snapshot.mileageKm} км</td></tr>
      <tr><th>Плановое ТО</th><td>${vehicle.nextMaintenanceDueKm === null ? '—' : vehicle.nextMaintenanceDueKm + ' км'}</td></tr>
      <tr><th>Уровень топлива</th><td>${snapshot.fuelEighths} из 8 делений</td></tr>
    </table>
    <h2>Комплектность автомобиля</h2>
    <div class="equipment">${equipment.map((item) => '<div><span class="check"></span>' + escape(item) + '</div>').join('')}</div>
    <h2>Внешние повреждения</h2>
    <p class="notes">${escape(snapshot.noDamage ? 'Повреждений нет' : snapshot.damageNotes)}</p>
    <img class="damage-diagram" alt="Схема автомобиля для отметок" src="data:image/jpeg;base64,${diagram}">
    <p><b>Условные обозначения:</b> 1 — царапина, 2 — царапина по лаку, 3 — вмятина, 4 — трещина, 5 — скол.</p>
    <p>Мойка: ____________________ &nbsp; Салон: ____________________</p>
    <h2>Особые отметки</h2>
    <p class="notes">${escape(snapshot.specialNotes || ' ')}</p>
    <p>${escape(lessor.name)} не несёт ответственности за утерю вещей, оставленных в автомобиле.</p>
    <div class="signatures">
      <div><b>Арендодатель${pickup ? ' · передал' : ' · принял'}</b><div class="line"></div>${escape(lessor.signer)}</div>
      <div><b>Арендатор${pickup ? ' · принял' : ' · передал'}</b><div class="line"></div>${escape(snapshot.customerSigner)}</div>
    </div>
    </body></html>`);
}
