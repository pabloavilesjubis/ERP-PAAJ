export class DteError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DteError';
  }
}

export class AuthError extends DteError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'MH_AUTH_FAILED', details);
    this.name = 'AuthError';
  }
}

export class FirmadorError extends DteError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'FIRMADOR_FAILED', details);
    this.name = 'FirmadorError';
  }
}

export class MhRejectedError extends DteError {
  constructor(
    public readonly mhMessage: string,
    public readonly observaciones: string[],
    details?: Record<string, unknown>,
  ) {
    super(`MH rechazó el documento: ${mhMessage}`, 'MH_REJECTED', details);
    this.name = 'MhRejectedError';
  }
}

export class TransientError extends DteError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'MH_TRANSIENT', details);
    this.name = 'TransientError';
  }
}

export class ValidationError extends DteError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION', details);
    this.name = 'ValidationError';
  }
}
