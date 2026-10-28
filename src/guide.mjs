// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The one source of the usage policy: the MCP `instructions`, the skill file `init` writes, and
 * the AGENTS.md block all carry this text. Tool descriptions say what a tool does; this says when
 * and in which order — never duplicate it in a per-agent file.
 */
export const GUIDE = `Chili3D is a browser CAD app. These tools drive the page the user is looking at: the page owns
the document and the geometry, and this server only forwards. The page's own tools are listed as
chili3d_<tool>, each with its JSON schema.

Bootstrap
- chili3d_status says whether a page is connected.
- chili3d_open starts the local bridge and opens the page. Ask the user to keep that tab in the
  foreground; a background tab is throttled and its screenshots go stale.
- A fresh page has no document. When chili3d_get_document_state reports hasActiveDocument: false,
  call chili3d_new_document.

Working
- Call chili3d_load_skill before a serious modeling session — it returns the app guide, the
  modeling API, recipes, queries and (in the Pro build) the direct-editing guide. Do not answer
  modeling questions from memory.
- Units are millimetres, angles are degrees.
- One run_program call is one undo step: its ops run in order and a failure rolls the whole call
  back. Refs from earlier calls persist, so re-run only the ops that failed.
- After creating or changing geometry: select the affected nodes, fit the view, then capture a
  screenshot. Clear the selection first when shading or edges need to be visible.
- An ambiguous target ("this edge", "that hole") is a pixel: screenshot first, then click_view.
- The user is watching the viewport. Say what you are about to do, and ask before anything
  destructive or genuinely ambiguous.
- Reply in the user's language.`;
