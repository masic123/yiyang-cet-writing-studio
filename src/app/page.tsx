import { questions } from "@/lib/content";
import Studio from "@/components/studio";
export default function Page() {
  const bank = questions();
  return (
    <Studio
      initialQuestion={
        bank.find(
          (q) =>
            q.examType === "CET4" &&
            q.task === "writing" &&
            q.session === "2026-06",
        ) || bank[0]
      }
      total={bank.length}
    />
  );
}
