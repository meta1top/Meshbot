import { redirect } from "next/navigation";

/** 首页即消息：重定向到消息中心。 */
export default function HomePage() {
  redirect("/messages");
}
