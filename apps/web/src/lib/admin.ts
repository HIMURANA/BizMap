/** API client for the platform-admin panel (DigitalLeon staff only; the server answers 404 to everyone else). */
import { req, send, type Role } from './api';

export interface AdminOverview {
  totals: {
    workspaces: number; suspended: number; users: number; disabled: number; new_users_7d: number; campaigns: number; sending: number;
    credits_issued: number; credits_used: number; revenue_bdt: number; whatsapp_connected: number;
  };
  payments: { tran_id: string; pack: string; amount_bdt: number; credits: number; status: string; created_at: string; workspace: string }[];
  activity: { admin_email: string; action: string; target: string | null; created_at: string }[];
}
export interface AdminWorkspaceRow {
  id: string; name: string; created_at: string; suspended_at: string | null; members: number; balance: number; campaigns: number; owner_email: string | null; whatsapp: boolean;
}
export interface AdminWorkspace {
  id: string; name: string; created_at: string; suspended_at: string | null; balance: number;
  members: { id: string; name: string; email: string; role: Role; last_login_at: string | null; disabled_at: string | null }[];
  ledger: { id: number; delta: number; reason: string; ref: string | null; created_at: string; by: string | null }[];
  campaigns: { id: string; name: string; channel: string; status: string; recipients: number; credits: number; created_at: string }[];
  payments: { tran_id: string; pack: string; amount_bdt: number; credits: number; status: string; provider: string; created_at: string; paid_at: string | null }[];
  settings: { wa_phone_number_id: string | null; wa_waba_id: string | null; has_token: boolean; sender_email: string | null; daily_email_cap: number } | null;
  data: AdminDataCounts;
}
/** Activity data a workspace holds, which an admin can delete per kind. */
export interface AdminDataCounts {
  campaigns: number; running_campaigns: number; recipients: number; conversations: number; messages: number; outbox: number; call_queues: number; call_items: number;
}
export type PurgeWhat = 'campaigns' | 'inbox' | 'outbox' | 'calls';
export interface AdminUserRow { id: string; name: string; email: string; created_at: string; last_login_at: string | null; disabled_at: string | null; is_platform_admin: boolean; workspaces: number }
export interface AdminUser extends Omit<AdminUserRow, 'workspaces'> {
  workspaces: { id: string; name: string; role: Role; suspended_at: string | null }[]; sessions: number;
}
export interface AdminCredit { id: number; delta: number; reason: string; created_at: string; workspace_id: string; workspace: string; by: string | null }
export interface AdminPayment { tran_id: string; pack: string; amount_bdt: number; credits: number; status: string; provider: string; created_at: string; paid_at: string | null; workspace_id: string; workspace: string }
export interface AdminAudit { id: number; admin_email: string; action: string; workspace_id: string | null; target: string | null; detail: Record<string, unknown> | null; created_at: string }

const enc = encodeURIComponent;
export const admin = {
  overview: () => req<AdminOverview>('/admin/overview'),
  workspaces: (q: string) => req<AdminWorkspaceRow[]>(`/admin/workspaces?q=${enc(q)}`),
  workspace: (id: string) => req<AdminWorkspace>(`/admin/workspaces/${id}`),
  rename: (id: string, name: string) => send(`/admin/workspaces/${id}`, 'PATCH', { name }),
  suspend: (id: string, reason: string) => send(`/admin/workspaces/${id}/suspend`, 'POST', { reason }),
  unsuspend: (id: string) => send(`/admin/workspaces/${id}/unsuspend`, 'POST', {}),
  adjustCredits: (id: string, delta: number, reason: string) => send<{ balance: number }>(`/admin/workspaces/${id}/credits`, 'POST', { delta, reason }),
  disconnectWhatsApp: (id: string) => send(`/admin/workspaces/${id}/disconnect-whatsapp`, 'POST', {}),
  setRole: (id: string, userId: string, role: Role) => send(`/admin/workspaces/${id}/members/${userId}`, 'PATCH', { role }),
  purge: (id: string, what: PurgeWhat, confirm: string) => send<{ deleted: Record<string, number> }>(`/admin/workspaces/${id}/purge`, 'POST', { what, confirm }),
  deleteWorkspace: (id: string, confirm: string) => send(`/admin/workspaces/${id}`, 'DELETE', { confirm }),
  users: (q: string) => req<AdminUserRow[]>(`/admin/users?q=${enc(q)}`),
  user: (id: string) => req<AdminUser>(`/admin/users/${id}`),
  disableUser: (id: string) => send(`/admin/users/${id}/disable`, 'POST', {}),
  enableUser: (id: string) => send(`/admin/users/${id}/enable`, 'POST', {}),
  signOutUser: (id: string) => send<{ sessions: number }>(`/admin/users/${id}/signout`, 'POST', {}),
  credits: () => req<AdminCredit[]>('/admin/credits'),
  payments: () => req<AdminPayment[]>('/admin/payments'),
  audit: () => req<AdminAudit[]>('/admin/audit'),
};
