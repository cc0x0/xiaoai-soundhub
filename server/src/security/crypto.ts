import crypto from "crypto";
import jwt from "jsonwebtoken";

export class SecurityCrypto {
  private static ALGORITHM = "aes-256-gcm";
  private static IV_LENGTH = 12;
  private static AUTH_TAG_LENGTH = 16;

  private static deriveKey(secret: string): Buffer {
    return crypto.scryptSync(secret || "SoundHub_Secure_Default_Salt_2026", "soundhub_salt_static", 32);
  }

  public static encrypt(plainText: string, secretKey: string): string {
    if (!plainText) return '';
    const key = this.deriveKey(secretKey);
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv) as crypto.CipherGCM;
    
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  public static decrypt(encryptedData: string, secretKey: string): string {
    if (!encryptedData) return '';
    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 3) return '';

      const [ivHex, authTagHex, encryptedHex] = parts;
      const key = this.deriveKey(secretKey);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv) as crypto.DecipherGCM;
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return '';
    }
  }

  public static hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
  }

  public static verifyPassword(password: string, storedHash: string): boolean {
    try {
      const [salt, originalHash] = storedHash.split(":");
      if (!salt || !originalHash) return false;
      const hash = crypto.scryptSync(password, salt, 64).toString("hex");
      return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
    } catch {
      return false;
    }
  }

  public static signToken(payload: object, secretKey: string, expiresIn = "30d"): string {
    return jwt.sign(payload, secretKey || "soundhub_jwt_default_key", { expiresIn } as jwt.SignOptions);
  }

  public static verifyToken<T = any>(token: string, secretKey: string): T | null {
    try {
      return jwt.verify(token, secretKey || "soundhub_jwt_default_key") as T;
    } catch {
      return null;
    }
  }

  public static maskText(str: string): string {
    if (!str || str.length <= 4) return "****";
    return str.slice(0, 3) + "****" + str.slice(-2);
  }
}
