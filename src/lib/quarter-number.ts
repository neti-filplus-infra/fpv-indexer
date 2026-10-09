export type QuarterNumberInput = QuarterNumber | string | number;

export function isQuarterNumberInput(
  input: unknown,
): input is QuarterNumberInput {
  if (typeof input !== 'string' && typeof input !== 'number') {
    return false;
  }

  try {
    QuarterNumber.from(input);
    return true;
  } catch {
    return false;
  }
}

export class QuarterNumber {
  private intValue: number;

  public static from(input: QuarterNumberInput) {
    return new QuarterNumber(input);
  }

  constructor(input: QuarterNumberInput) {
    let intValue: number;

    if (input instanceof QuarterNumber) {
      intValue = input.toNumber();
    } else if (typeof input === 'string') {
      const lower = input.toLowerCase();
      const numericString = lower.startsWith('q') ? lower.slice(1) : input;
      intValue = parseInt(numericString, 10);
    } else {
      intValue = input;
    }

    if (isNaN(intValue) || !Number.isInteger(intValue) || intValue < 1) {
      throw new TypeError(
        'Quarter number must be an integer greather than or equal 1.',
      );
    }

    this.intValue = intValue;
  }

  public toString(): string {
    return `Q${this.intValue}`;
  }

  public toNumber(): number {
    return this.intValue;
  }

  public toJSON() {
    return this.toString();
  }
}
