import { getArtifacts, getProjects, getSessions, getStatus } from "@/lib/api"
import { queryProjectBindingPermission } from "@/lib/project-source"

export const statusQuery = { queryKey: ["host-status"], queryFn: getStatus, refetchInterval: 5_000 }
export const sessionsQuery = { queryKey: ["sessions"], queryFn: getSessions, refetchInterval: 5_000 }
export const projectsQuery = {
  queryKey: ["projects", "with-permissions"],
  queryFn: async () => {
    const result = await getProjects()
    return {
      projects: await Promise.all(result.projects.map(async (project) => ({
        ...project,
        permission: project.sourceOwner === "browser" ? await queryProjectBindingPermission(project.bindingId) : project.sourceOwner,
      }))),
    }
  },
}
export const artifactsQuery = { queryKey: ["artifacts"], queryFn: getArtifacts }
