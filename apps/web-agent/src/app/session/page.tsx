"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

function SessionRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get("id");

  useEffect(() => {
    router.replace(id ? `/assistant?id=${id}` : "/assistant");
  }, [id, router]);

  return null;
}

/** /session 兼容跳板：旧链接自动重定向到 /assistant?id=。 */
export default function SessionPage() {
  return (
    <Suspense fallback={null}>
      <SessionRedirect />
    </Suspense>
  );
}
