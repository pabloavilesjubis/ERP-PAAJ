/**
 * Super-admin de PLATAFORMA (dueño del SaaS) — distinto del admin por-tenant.
 * Se define por allowlist de emails en la env `PLATFORM_ADMIN_EMAILS` (CSV).
 * Solo estos usuarios pueden crear/controlar tenants vía /v2/admin/*.
 */
export function platformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(email?: string | null): boolean {
  if (!email) return false;
  return platformAdminEmails().includes(email.toLowerCase());
}
