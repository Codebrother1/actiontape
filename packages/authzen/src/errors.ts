export class AuthzenMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthzenMappingError";
  }
}

export class AuthzenRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthzenRequestError";
  }
}

export class CoazMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoazMappingError";
  }
}
