self.addEventListener('push', (event) => {
  const message = event.data?.json();
  if (!Number.isSafeInteger(message?.bookingId) || message.bookingId < 1) return;
  const checkout = message.event === 'checkout.started';
  if (!checkout && message.event !== 'rentalReturn.started') return;
  event.waitUntil(
    self.registration.showNotification(
      checkout ? 'Началась выдача автомобиля' : 'Клиент приехал сдавать автомобиль',
      {
        body: 'Аренда №' + message.bookingId,
        icon: '/icons/icon-192.png',
        tag: message.eventId,
        data: { bookingId: message.bookingId, step: checkout ? 'checkout' : 'return' },
      },
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  const { bookingId, step } = event.notification.data;
  event.notification.close();
  if (!Number.isSafeInteger(bookingId) || bookingId < 1 || !['checkout', 'return'].includes(step))
    return;
  const url = new URL('/rentals/' + bookingId + '?step=' + step, self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.url === url.href);
      if (existing) return existing.focus();
      return self.clients.openWindow(url.href);
    })(),
  );
});
