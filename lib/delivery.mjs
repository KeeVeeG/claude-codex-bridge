/** Public projection only; the durable record and transport receipts stay internal. */
export function publicDelivery(record) {
  const endpoint = ({ kind, id, host_id }) => ({ app: kind, id, ...(host_id ? { host_id } : {}) });
  const error = record.error;
  return {
    message_id: record.id, from: endpoint(record.route.from), to: endpoint(record.route.to),
    message: record.message, status: record.status,
    ...(typeof record.manual === 'boolean' ? { manual: record.manual } : {}),
    created_at: record.createdAt,
    ...(record.updatedAt !== undefined ? { updated_at: record.updatedAt } : {}),
    ...(error !== undefined && error !== null ? { error: typeof error === 'string' ? error
      : typeof error.message === 'string' ? error.message : JSON.stringify(error) } : {}),
  };
}
