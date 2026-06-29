import { ShareView } from "./share-view";

/**
 * 网盘公开分享匿名页 — server component 薄壳，传 token 给 client view。
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ShareView token={token} />;
}
