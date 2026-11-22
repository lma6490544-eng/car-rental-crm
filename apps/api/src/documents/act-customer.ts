// Shared by act generation, the document snapshot and signing. The customer alias is u.
export const actCustomerSigner = `CASE WHEN u.type='company'
  THEN COALESCE(NULLIF(u.details->>'representativeName',''),u.display_name)
  ELSE u.display_name END`;

// Older versions have no customer version. Their printed identity is still available.
export const actMatchesCustomer = `(a.customer_version=u.version OR
  (a.customer_version IS NULL AND a.snapshot->>'customerName'=u.display_name
    AND a.snapshot->>'customerSigner'=(${actCustomerSigner})))`;
