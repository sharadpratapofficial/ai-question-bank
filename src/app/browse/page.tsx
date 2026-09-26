import { redirect } from "next/navigation";

interface BrowseRedirectPageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BrowseRedirectPage({ searchParams }: BrowseRedirectPageProps) {
    const params = await searchParams;
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
            for (const v of value) query.append(key, v);
            continue;
        }
        if (typeof value === "string") query.set(key, value);
    }

    const qs = query.toString();
    redirect(qs ? `/questions?${qs}` : "/questions");
}
