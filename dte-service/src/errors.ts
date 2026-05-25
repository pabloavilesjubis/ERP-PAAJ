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

/**
 * Lanzado cuando el caller no resolvió correlativo y dte-service tampoco
 * puede (porque el tipo nunca fue sembrado). Reservar sin seed sería
 * partir de 0 → emisión arrancaría en 1 → choque con DTEs históricos en
 * MH. Sin seed explícito, NO emitimos. El seed debe ser una acción
 * administrativa auditable: CorrelativosTab o POST /correlativos/sembrar.
 */
export class CorrelativoNotSeededError extends DteError {
  constructor(tipoDte: string) {
    super(
      `No existe correlativo fiscal inicial configurado para tipo DTE ${tipoDte}. ` +
      `dte-service NO arranca secuencias en 1 sin autorización explícita. ` +
      `Sembrá el último consecutivo emitido históricamente vía CorrelativosTab del ERP ` +
      `o vía POST /correlativos/sembrar antes de volver a emitir.`,
      'CORRELATIVO_NOT_SEEDED',
      { tipoDte },
    );
    this.name = 'CorrelativoNotSeededError';
  }
}

/**
 * @deprecated Mantenido como alias semántico — la causa real ahora es
 * NOT_SEEDED. Conservado por compatibilidad con cualquier consumidor que
 * dependa del code string anterior.
 */
export class CorrelativoNotConfiguredError extends DteError {
  constructor(tipoDte: string) {
    super(
      `No existe correlativo configurado para tipo DTE ${tipoDte}.`,
      'CORRELATIVO_NOT_CONFIGURED',
      { tipoDte },
    );
    this.name = 'CorrelativoNotConfiguredError';
  }
}
