import { redirect } from "next/navigation";

// The QBG Modifier moved under the "QBG" hub (sidebar → QBG → QBG Modifier tab).
// This route now just redirects any old links/bookmarks there.
export default function QbgModificationRedirect() {
    redirect("/qbg");
}
