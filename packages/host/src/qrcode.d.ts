declare module "qrcode" {
  const QRCode: {
    toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
    toString(text: string, options?: Record<string, unknown>): Promise<string>;
    toFile(path: string, text: string, options?: Record<string, unknown>): Promise<void>;
  };
  export default QRCode;
}
