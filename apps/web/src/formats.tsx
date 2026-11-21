import { Input, Space } from 'antd';
export const normalizePhone = (value: string) => {
  const n = value.replace(/[\s()-]/g, '');
  return /^8\d{10}$/.test(n) ? '+7' + n.slice(1) : n;
};
export const phoneRules = [
  {
    validator: (_: unknown, v: string) =>
      !v || /^\+7\d{10}$/.test(normalizePhone(v))
        ? Promise.resolve()
        : Promise.reject(new Error('Укажите +7 и 10 цифр.')),
  },
];
export function PhoneInput({
  value = '',
  onChange,
  ...props
}: {
  value?: string;
  onChange?: (v: string) => void;
  id?: string;
}) {
  return (
    <Input
      {...props}
      value={value}
      type="tel"
      placeholder="+7 (999) 999-99-99"
      maxLength={18}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={() => onChange?.(normalizePhone(value))}
    />
  );
}
export const plateCanonical = (v: string) =>
  v
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(
      /[АВЕКМНОРСТУХ]/g,
      (c) =>
        ({
          А: 'A',
          В: 'B',
          Е: 'E',
          К: 'K',
          М: 'M',
          Н: 'H',
          О: 'O',
          Р: 'P',
          С: 'C',
          Т: 'T',
          У: 'Y',
          Х: 'X',
        })[c]!,
    );
export const platePattern = /^[ABEKMHOPCTYX]\d{3}[ABEKMHOPCTYX]{2}\d{2,3}$/;
export function PlateInput({
  value = '',
  onChange,
}: {
  value?: string;
  onChange?: (v: string) => void;
}) {
  const compact = value.replace(/\s/g, '');
  const main = compact.slice(0, 6),
    region = compact.slice(6);
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input
        aria-label="Госномер"
        placeholder="А 000 АА"
        value={main}
        maxLength={8}
        onChange={(e) =>
          onChange?.(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 6) + region)
        }
      />
      <Input
        aria-label="Код региона"
        placeholder="Регион"
        style={{ width: 95 }}
        inputMode="numeric"
        maxLength={3}
        value={region}
        onChange={(e) => onChange?.(main + e.target.value.replace(/\D/g, '').slice(0, 3))}
      />
    </Space.Compact>
  );
}
