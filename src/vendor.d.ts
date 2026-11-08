declare module 'sm-crypto/src/sm2/rng.js' {
  export class SecureRandom {
    nextBytes(target: number[]): void;
  }
}
