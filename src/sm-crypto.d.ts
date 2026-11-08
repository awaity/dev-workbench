import 'sm-crypto';

declare module 'sm-crypto' {
  namespace sm2 {
    function getPublicKeyFromPrivateKey(privateKey: string): string;
    function verifyPublicKey(publicKey: string): boolean;
  }
}
