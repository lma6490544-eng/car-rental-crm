import { renderPdf } from './render-pdf';
import type { ContractSnapshot } from './contracts.service';

const dateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'short',
  timeStyle: 'short',
});
const date = (value: string) => dateTime.format(new Date(value));
const money = (value: string) => new Intl.NumberFormat('ru-RU').format(BigInt(value)) + ' ₽';
const isoDay = (value?: string) => value?.split('-').reverse().join('.');

export function escape(value: string | number) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

function rows(items: [string, string | number | null | undefined][]) {
  return items
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value!)}</td></tr>`)
    .join('');
}

function contractHtml(
  id: number,
  revision: number,
  templateVersion: string,
  snapshot: ContractSnapshot,
) {
  if (!['individual-v1', 'company-v1'].includes(templateVersion))
    throw new Error('Unknown contract template version');
  const company = templateVersion === 'company-v1';
  const { customer, vehicle, terms, lessor, additionalDriver } = snapshot;
  const d = customer.details;
  const prices = terms.periods
    .map(
      (period) => `<tr>
    <td>${escape(date(period.startsAt))} — ${escape(date(period.endsAt))}</td>
    <td>${escape(money(period.customDailyRateRub ?? period.dailyRateRub))}</td>
  </tr>`,
    )
    .join('');
  const freeDays = terms.dayLines
    .filter((day) => day.nonBillable)
    .map(
      (day) =>
        `<li>Сутки ${day.dayIndex}, ${escape(date(day.startAt))} — ${escape(date(day.endAt))}.
      0 ₽${day.reason ? ' · ' + escape(day.reason) : ''}</li>`,
    )
    .join('');
  const customerRows: [string, string | undefined][] = company
    ? [
        ['ИНН / КПП / ОГРН', [customer.inn, d.kpp, d.ogrn].filter(Boolean).join(' / ')],
        ['Юридический адрес', d.legalAddress],
        ['Почтовый адрес', d.postalAddress],
        ['Банк', d.bank],
        ['БИК', d.bik],
        ['Расчётный счёт', d.account],
        ['Корреспондентский счёт', d.correspondentAccount],
        ['Представитель', d.representativeName],
        ['Телефон представителя', d.representativePhone],
        ['Основание полномочий', d.authority],
        ['Факс', d.fax],
      ]
    : [
        ['Дата рождения', isoDay(d.birthDate)],
        ['Паспорт', [d.passportSeries, d.passportNumber].filter(Boolean).join(' ')],
        ['Паспорт выдан', [d.passportIssuer, isoDay(d.passportDate)].filter(Boolean).join(', ')],
        ['Адрес регистрации', d.registrationAddress],
        ['Фактический адрес', d.actualAddress],
        [
          'Водительское удостоверение',
          [d.licenseNumber, isoDay(d.licenseDate)].filter(Boolean).join(', '),
        ],
      ];
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Договор аренды № ${id}</title>
  <style>
    @page {
      size: A4;
      margin: 13mm 14mm 15mm;
      @bottom-right { content: "Стр. " counter(page) " из " counter(pages); font: 8pt Arial, sans-serif; }
    }
    body { font: 9.5pt/1.25 Arial, sans-serif; color: #111; overflow-wrap: anywhere; }
    h1 { text-align: center; margin: 0 0 9pt; font-size: 15pt; }
    h2 { margin: 10pt 0 3pt; font-size: 10.5pt; break-after: avoid; }
    p { margin: 3.5pt 0; orphans: 2; widows: 2; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th,td { padding: 2pt 4pt; border: 0.5pt solid #777; text-align: left; vertical-align: top; }
    th { width: 32%; } tr { break-inside: avoid; } td { white-space: pre-wrap; }
    .meta { display: flex; justify-content: space-between; margin-bottom: 9pt; }
    .execution { break-inside: avoid; }
    .signatures { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10pt;
      margin-top: 10pt; break-inside: avoid; }
    .signature { padding-top: 12pt; border-top: 0.5pt solid; margin-top: 15pt; }
  </style>
  <body>
    <h1>Договор аренды транспортного средства без экипажа № ${id}</h1>
    <div class="meta"><span>Санкт-Петербург</span><span>${escape(snapshot.issuedOn)} · редакция ${revision}</span></div>
    <p><b>Арендодатель:</b> ${escape(lessor.name)} в лице ${escape(lessor.signer)}, основание полномочий: ${escape(lessor.authority)}.</p>
    <p><b>Арендатор:</b> ${escape(customer.displayName)}${company ? ' в лице ' + escape(d.representativeName ?? '') + ', основание полномочий: ' + escape(d.authority ?? '') : ''}.</p>
    <p>1. В соответствии с условиями настоящего договора Арендодатель предоставляет Арендатору транспортное средство (далее — Автомобиль, предмет аренды) за плату во временное владение и пользование без оказания услуг по управлению им и его технической эксплуатации, а Арендатор обязуется своевременно выплачивать Арендодателю установленную настоящим Договором арендную плату и по окончании срока аренды возвратить автомобиль Арендодателю в том состоянии, в котором он его получил, с учетом нормального износа или в состоянии, обусловленном договором.</p>
    <p>2. Данные, позволяющие определенно установить Автомобиль, подлежащий передаче Арендатору в качестве объекта аренды, указаны в акте приема-передачи автомобиля, который является неотъемлемой частью настоящего договора.</p>
    <table>${rows([
      ['Автомобиль', vehicle.brand + ' ' + vehicle.model],
      ['Госномер', vehicle.plate],
      ['VIN', vehicle.vin],
      ['Год выпуска', vehicle.year],
    ])}</table>
    <p>3. Положения и условия Договора состоят из настоящего документа, приложений к нему, акта приема-передачи и возврата Автомобиля, положений и условий, поименованных в настоящем Договоре и размещенных на сайте Арендодателя (https://autoliga.info) Правил аренды транспортных средств, утвержденных приказом Арендодателя №6 от 19.07.2025 (далее — Правила аренды), составляющих неотъемлемую часть настоящего договора. Во всем остальном, что не предусмотрено настоящим Договором и (или) Правилами аренды стороны руководствуются нормами гражданского законодательства Российской Федерации.</p>
    <p>4. Заключая настоящий договор, Арендатор подтверждает, что ознакомился с вышеуказанными Правилами аренды транспортных средств, содержание которых ему понятно, и он обязуется их соблюдать.</p>
    <p>5. Преимущественное местонахождение: Санкт-Петербург и Ленинградская область.</p>
    <p>6. Размер обеспечительного платежа: ${escape(money(snapshot.securityDepositRub))}.</p>
    <p>7. Контрактный пробег: не более ${terms.effectiveMileageLimitKm} км, суточный пакет ${terms.dailyMileagePackageKm} км.</p>
    <p>8. Наличие КАСКО: ${snapshot.casco === null ? 'не указано' : snapshot.casco ? 'да' : 'нет'}.</p>
    <h2>9. Срок действия договора и размер арендной платы</h2>
    <table>${rows([
      ['Выдача', date(terms.startAt)],
      ['Возврат', date(terms.agreedReturnAt)],
      ['Договорных суток', terms.contractDays],
      ['Оплачиваемых суток', terms.billableDays],
      ['Арендная плата', money(terms.finalTotalRub)],
      ['В т.ч. НДС 5%', money(snapshot.includedVatRub)],
    ])}</table>
    ${prices ? '<h2>Ставки по периодам</h2><table><thead><tr><th>Период</th><th>За сутки</th></tr></thead><tbody>' + prices + '</tbody></table>' : ''}
    ${freeDays ? '<h2>Бесплатные сутки «Вых»</h2><ul>' + freeDays + '</ul>' : ''}
    <h2>10. Стоимость дополнительных услуг</h2>
    <p>10.1. Мойка автомобиля при возврате — ${escape(money(terms.rulesSnapshot.washRub))} при выборе этой услуги оператором.</p>
    <p>10.2. Дополнительный пробег — ${escape(money(terms.rulesSnapshot.excessKmRub))} за километр сверх контрактного пробега.</p>
    <p>10.3. При возврате позже согласованного времени полные сутки рассчитываются по согласованной суточной ставке. Остаток менее часа не оплачивается, от одного до четырёх полных часов включительно — ${escape(money(terms.rulesSnapshot.lateHourRub))} за час, от пяти полных часов — согласованная суточная ставка. К оплате применяется большая из доплат за опоздание и превышение контрактного пробега. Топливо, мойка и ущерб учитываются отдельно.</p>
    ${company ? '<p>11. В случае ненадлежащего исполнения Арендатором обязательств по оплате, предусмотренных Договором, Арендатор обязуется оплатить Арендодателю неустойку (пени) в размере 0,2% от суммы задолженности за каждый день просрочки.</p>' : ''}
    <p>${company ? 12 : 11}. Часы выдачи и возврата автомобиля — с 09:15 до 20:15 ежедневно.</p>
    ${
      additionalDriver
        ? '<h2>Дополнительный водитель</h2><table>' +
          rows([
            ['ФИО', additionalDriver.fullName],
            ['Паспорт', additionalDriver.passport],
            ['Адрес', additionalDriver.address],
            ['Телефон', additionalDriver.phone],
            ['Водительское удостоверение', additionalDriver.license],
          ]) +
          '</table>'
        : ''
    }
    <h2>Реквизиты арендатора</h2>
    <table>${rows([['Арендатор', customer.displayName], ...customerRows, ['Телефон', customer.phone], ['Email', customer.email]])}</table>
    <section class="execution">
    <h2>Реквизиты арендодателя</h2>
    <table>${rows([
      ['Арендодатель', lessor.name],
      ['Реквизиты', lessor.requisites],
      ['Подписант', lessor.signer],
      ['Основание полномочий', lessor.authority],
    ])}</table>
    <div class="signatures">
      <div><b>Арендодатель</b><div class="signature">${escape(lessor.signer)}</div></div>
      <div><b>Арендатор</b><div class="signature">${escape((company ? d.representativeName : customer.displayName) ?? '')}</div></div>
    </div>
    </section>
  </body></html>`;
}

export async function renderContract(
  id: number,
  revision: number,
  templateVersion: string,
  snapshot: ContractSnapshot,
) {
  return renderPdf(contractHtml(id, revision, templateVersion, snapshot));
}
