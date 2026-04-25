/**
 * x402 mock — accept-all stub for M0 tests.
 * The real x402 facilitator validates payment headers and settlements.
 * In M0 there is no escrow/payment flow, so this stub simply returns
 * an accepted response for any payment request, allowing higher-level
 * tests to proceed without standing up the Coinbase facilitator.
 */

export interface X402PaymentRequest {
  amount: bigint;
  currency: string;
  recipient: string;
  memo?: string;
}

export interface X402PaymentResponse {
  accepted: boolean;
  transactionId: string;
  settledAt: number;
}

/**
 * Accept any payment request and return a fake transaction ID.
 * Always synchronous — no network calls.
 */
export function acceptPayment(request: X402PaymentRequest): X402PaymentResponse {
  return {
    accepted: true,
    transactionId: `mock-x402-${Date.now()}-${request.recipient.slice(0, 8)}`,
    settledAt: Date.now(),
  };
}
