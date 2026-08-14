import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminGate";
import { MapAdmin } from "@/components/MapAdmin";

export const metadata: Metadata = {
  title: "Map Lab | Draw & Drive",
  description: "Upload and test custom driving environments.",
};

export default function MapAdminPage() {
  return (
    <AdminGate>
      <MapAdmin />
    </AdminGate>
  );
}
