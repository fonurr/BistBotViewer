export function accountIdentityKey(accountId: string, brokerageId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(brokerageId)}`;
}
