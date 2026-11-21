import type { CustomerMatch } from '../../contracts';
import { useEffect, useState } from 'react';
import { api } from '../../api';
export function useFinanceCustomerSearch() {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<{ value: number; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (query.trim().length < 2) {
        setOptions([]);
        return;
      }
      void api<{ items: CustomerMatch[] }>('/booking-customers?q=' + encodeURIComponent(query))
        .then((v) => {
          if (alive)
            setOptions(
              v.items.map((c) => ({ value: c.id, label: c.displayName + ' · ' + c.phone })),
            );
        })
        .catch(() => {
          if (alive) setOptions([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  return { options, setQuery };
}
