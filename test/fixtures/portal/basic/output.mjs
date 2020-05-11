import createFetcher from './create-fetcher';
export const fetchProjects = createFetcher.register(__filename, "fetchProjects");

module.exports = function () {
  return fetchProjects();
};
