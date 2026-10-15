// Placeholder until Finance arrives (a later phase replaces this file with the real invoices module).
// Clients import these names; with no invoices yet they show nothing.
export const INVOICE_STATUS = { draft: 'Draft', sent: 'Sent', paid: 'Paid', cancelled: 'Cancelled' };
export const invoiceState = (i) => i.status;
export const invoiceBadge = (i) => `<span class="badge ${i.status}">${INVOICE_STATUS[i.status] || i.status}</span>`;
export const invAmount = (i) => String(i.amount ?? '');
export const openInvoiceEditor = () => {};
export const openInvoiceView = () => {};
