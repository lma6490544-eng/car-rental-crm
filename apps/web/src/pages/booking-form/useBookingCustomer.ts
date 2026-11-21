import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import type { Customer } from '../../catalog';
import type { CustomerMatch } from '../../contracts';
import { api, errorMessage } from '../../api';
import { normalizePhone } from '../../formats';
import type { BookingFormValues } from './types';
const fullDetails = (c: Customer) => {
  const details = { ...c.details };
  if (c.type === 'individual' && !details.lastName && !details.firstName) {
    const parts = c.displayName.trim().split(/\s+/);
    details.lastName = parts[0] ?? '';
    details.firstName = parts[1] ?? '';
    details.middleName = parts.slice(2).join(' ');
  }
  return details;
};

export function useBookingCustomer(form: FormInstance<BookingFormValues>, customerId?: number) {
  const [selected, setSelected] = useState<Customer>(),
    [selecting, setSelecting] = useState(false),
    [query, setQuery] = useState('');
  const [matches, setMatches] = useState<CustomerMatch[]>([]),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState('');
  const [searchField, setSearchField] = useState<'name' | 'phone'>('name');
  const searchGeneration = useRef(0);
  const sequence = useRef(0);
  const [extras, setExtras] = useState<string[]>([]);
  useLayoutEffect(() => {
    if (!selected) return;
    const details = fullDetails(selected);
    form.setFieldsValue({
      type: selected.type,
      displayName: selected.displayName,
      phone: selected.phone,
      email: selected.email,
      inn: selected.inn,
    });
    // setFields retains old errors unless they are explicitly replaced.
    form.setFields(
      Object.entries(details).map(([key, value]) => ({
        name: ['details', key],
        value,
        errors: [],
        warnings: [],
      })),
    );
    void form
      .validateFields([
        'displayName',
        'phone',
        'email',
        'inn',
        ...Object.keys(details).map((key) => ['details', key]),
      ])
      .catch(() => {});
  }, [selected, form]);
  useEffect(() => {
    let alive = true;
    const generation = searchGeneration.current;
    if (customerId || query.trim().length < 2) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setMatches([]);
    setSearching(true);
    setSearchError('');
    const timer = setTimeout(() => {
      void api<{ items: CustomerMatch[] }>(
        '/booking-customers?q=' + encodeURIComponent(query.trim()),
      )
        .then((r) => {
          if (alive && generation === searchGeneration.current) setMatches(r.items);
        })
        .catch((e) => {
          if (alive && generation === searchGeneration.current) setSearchError(errorMessage(e));
        })
        .finally(() => {
          if (alive && generation === searchGeneration.current) setSearching(false);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, searchField, customerId]);
  const choose = useCallback(
    async (id: string) => {
      const current = ++sequence.current;
      searchGeneration.current++;
      setSelecting(true);
      setSearchError('');
      setQuery('');
      setMatches([]);
      try {
        const c = await api<Customer>('/customers/' + Number(id));
        if (current !== sequence.current) return;
        form.setFieldsValue({
          type: c.type,
          displayName: c.displayName,
          phone: c.phone,
          email: c.email,
          inn: c.inn,
        });
        form.setFieldValue('details', fullDetails(c));
        setSelected(c);
        setExtras([]);
      } catch (e) {
        if (current === sequence.current) setSearchError(errorMessage(e));
      } finally {
        if (current === sequence.current) setSelecting(false);
      }
    },
    [form],
  );
  useEffect(() => {
    if (customerId) void choose(String(customerId));
    return () => {
      sequence.current++;
    };
  }, [customerId, choose]);
  const resetClient = () => {
    sequence.current++;
    searchGeneration.current++;
    setSelecting(false);
    setSelected(undefined);
    setQuery('');
    setMatches([]);
    setSearchError('');
    setExtras([]);
    form.setFieldsValue({ displayName: '', phone: '', email: '', inn: '' });
    form.setFieldValue('details', {});
  };
  const search = (text: string, field: 'name' | 'phone') => {
    if (customerId) return;
    const next = field === 'phone' ? normalizePhone(text).replace(/[^+\d]/g, '') : text;
    if (next === query && field === searchField) return;
    sequence.current++;
    searchGeneration.current++;
    setSelecting(false);
    setSearchField(field);
    setQuery(next);
    setMatches([]);
  };
  const cancelSelectionOnEdit = (changed: Partial<BookingFormValues>) => {
    if (
      selecting &&
      (changed.details || 'phone' in changed || 'email' in changed || 'displayName' in changed)
    ) {
      sequence.current++;
      setSelecting(false);
    }
  };
  const changeCustomerType = () => {
    searchGeneration.current++;
    setQuery('');
    setMatches([]);
    form.setFieldsValue({ displayName: '', inn: '' });
    form.setFieldValue('details', {});
  };
  return {
    selected,
    selecting,
    query,
    matches,
    searching,
    searchError,
    searchField,
    extras,
    setExtras,
    choose,
    resetClient,
    search,
    cancelSelectionOnEdit,
    changeCustomerType,
  };
}
