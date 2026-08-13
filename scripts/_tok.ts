import * as dotenv from "dotenv"; import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
import { SignJWT } from "jose";
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? "wwc-draft-secret-change-in-prod");
new SignJWT({ username: "nishant" }).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("1h").sign(SECRET).then(t=>console.log(t));
