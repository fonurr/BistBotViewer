import {
  activeOrderStatusRole,
  displayActiveOrderStatus,
  displayStatus,
  statusRole,
} from './status';
import { makeActiveOrder } from '../test/fixtures';

describe('status vocabulary', () => {
  it('never leaks stored cancellation or partial-fill words', () => {
    expect(displayStatus('CanceledByUser')).toBe('By user');
    expect(displayStatus('PartiallyFilled')).toBe('Partly filled');
  });

  it('keeps unacknowledged and cancel-in-flight rows out of green', () => {
    expect(statusRole('New', { hasExchangeId: false })).toBe('wait');
    expect(statusRole('New', { hasExchangeId: true })).toBe('live');
    expect(statusRole('PartiallyFilled', { hasExchangeId: true, cancelInFlight: true })).toBe(
      'wait',
    );
    expect(statusRole('Unconfirmed')).toBe('warn');
  });

  it('degrades transient and future active statuses without hiding partial fills', () => {
    expect(displayActiveOrderStatus(makeActiveOrder({ status: 'PendingCancel' }))).toBe('New');
    expect(
      displayActiveOrderStatus(makeActiveOrder({ status: 'PendingReplace', filledQuantity: 4 })),
    ).toBe('Partly filled');
    expect(activeOrderStatusRole(makeActiveOrder({ status: 'AcceptedForBidding' }))).toBe('live');
    expect(displayStatus('FutureMatriksState')).toBe('Unconfirmed');
    expect(statusRole('FutureMatriksState')).toBe('warn');
  });
});
