import { redirect } from "next/navigation";

/** 首页即助手：重定向到助手区。 */
export default function HomePage() {
  redirect("/assistant");
}
