import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminGate";
import { MapAdmin } from "@/components/MapAdmin";

export const metadata: Metadata = {
  title: "맵 제작실 | AI 바이블 드라이브",
  description: "주행 환경을 올리고 테스트합니다.",
};

export default function MapAdminPage() {
  return (
    <AdminGate>
      <MapAdmin />
    </AdminGate>
  );
}
